var cluster = require('cluster')
var http = require('http')
var numCPUs = require('os').cpus().length
var net = require('net')
var EventEmitter = require('events').EventEmitter
var split = require('split') 
var parse = require('through-parse')
var through = require('through')
var fs = require('fs')
var path = require('path')

var headpath = path.join(__dirname + '/HEAD')
var ee = new EventEmitter

function readHEAD() {
  return fs.readFileSync(headpath).toString()
}

function writeHEAD(value) {
  return fs.writeFileSync(headpath, value)
}

module.exports = function(opts) {

  if (typeof opts == 'string') {
    opts = { target: opts }
  }
  if (typeof opts['zero-downtime'] === 'undefined') {
    opts['zero-downtime'] = true
  }
  if (opts.head) {
    headpath = opts.head
  }

  if (!cluster.isMaster) {
    try {
      require(readHEAD())
    }
    catch(ex) {
      console.error(ex)
    }
    return
  }

  writeHEAD(opts.target)

  function sig(cmd, value, norespawn) {
    
    if (norespawn) {
      setTimeout(function() {
        process.kill()
      }, 1e3)
    }

    var keys = Object.keys(cluster.workers)

    function broadcast(keys) {
      keys.forEach(function(id, index) {

        if (cmd === 'message') {
          cluster.workers[id].send(value)
        }
        else if (cmd === 'upgrade' && opts['zero-downtime']) {

          if (index % 2 === 0 && index !== keys.length-1) { 
            cluster.fork()
            setImmediate(function() {
              cluster.workers[id].disconnect()
            })
          }
          else {
            cluster.workers[id].disconnect()
            cluster.workers[id].on('disconnect', function() {
              cluster.fork()
            })
          }
        }
        else {

          cluster.workers[id].kill()

          if (norespawn) {
            if (index === keys.length-1) {
              ee.emit('log', { value: 'OK', cmd: 'die' })
            }
            return
          }
          cluster.fork()
        }

        if (index === keys.length-1) {
          ee.emit('log', { value: 'OK', cmd: cmd })
        }
      })
    }

    if (cmd === 'upgrade') {
      var mpath = path.resolve(value)
      return fs.stat(mpath, function(err, stat) {
        if (!err) {
          writeHEAD(mpath)
          return broadcast(keys)
        }
        ee.emit('log', { value: err, cmd: cmd })
      })
    }

    broadcast(keys)
  }

  //
  // create a server to listen for out of process 
  // instructions to kill, disconnect or message workers.
  //
  var server = net.createServer(function(conn) {

    var cmd

    function log(d) {
      conn.write(JSON.stringify(d) + '\n')
    }

    ee.on('log', log)

    conn.on('close', function() {
      ee.removeListener('log', log)
    })

    conn.on('error', function(err) {
      ee.emit('log', { value: err, cmd: cmd })
    })

    conn
      .pipe(split())
      .pipe(parse())
      .pipe(through(function(data) {
        if (!data || !data.cmd) return

        cmd = data.cmd

        switch(cmd) {
          case 'upgrade':
            if (opts['pre-upgrade']) {
              return require(opts['pre-upgrade'])(data, function(err, value) {
                if (!err) {
                  sig('upgrade', value || data.value || opts.target)
                }
              })
            }
            sig('upgrade', data.value)
          break

          case 'die':
            sig('die', null, true)
          break

          case 'kill':
            sig('kill')
          break

          case 'message':
            if (data.value) {
              sig('message', data.value)
            }
          break
        }
      }))
  })

  server.listen(opts.port || 3000, opts.address, function() {
    console.log('Starting on port %d', opts.port)
  })

  var forks = opts.forks || numCPUs

  for (var i = 0; i < forks; i++) {
    cluster.fork()
  }
}

