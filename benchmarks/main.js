// *****************************************************************************
// Copyright 2013-2016 Aerospike, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License")
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// *****************************************************************************

// *****************************************************************************
// node -O 10000 -P 4 -R 0.5
// *****************************************************************************

var aerospike = require('aerospike')
var cluster = require('cluster')
var winston = require('winston')
var stats = require('./stats')
var alerts = require('./alerts')
var argv = require('./config.json')

// *****************************************************************************
// Globals
// *****************************************************************************

var OP_TYPES = 4 // READ, WRITE, SCAN and QUERY
var STATS = 3 // OPERATIONS, TIMEOUTS and ERRORS

var queryWorkers = 0
var scanWorkers = 0
var online = 0
var exited = 0
var rwOnline = 0
var queryOnline = 0
var scanOnline = 0

//
// Number of completed operations(READ & WRITE), timed out operations and operations that ran into error per second
//
var interval_stats = new Array(OP_TYPES)
reset_interval_stats()

if (argv.querySpec !== undefined) {
  queryWorkers = argv.querySpec.length
}

if (argv.scanSpec !== undefined) {
  scanWorkers = argv.scanSpec.length
}

var rwWorkers = argv.processes - queryWorkers - scanWorkers

if (!cluster.isMaster) {
  console.error('main.js must not run as a child process.')
  process.exit()
}

var FOPS = (argv.operations / (argv.reads + argv.writes))
var ROPS = FOPS * argv.reads
var WOPS = FOPS * argv.writes
var ROPSPCT = ROPS / argv.operations * 100
var WOPSPCT = WOPS / argv.operations * 100

if ((ROPS + WOPS) < argv.operations) {
  var DOPS = argv.operations - (ROPS + WOPS)
  ROPS += DOPS
}

if (argv.time !== undefined) {
  argv.time = stats.parse_time_to_secs(argv.time)
  argv.iterations = undefined
}

var alert = {mode: argv.alert, filename: argv.filename}
alerts.setupAlertSystem(alert)

// *****************************************************************************
// Logging
// *****************************************************************************

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({
      level: 'info',
      silent: false,
      colorize: true
    })
  ]
})

// *****************************************************************************
// Functions
// *****************************************************************************

function finalize () {
  stats.stop()
  if (argv.summary === true && rwWorkers > 0) {
    return stats.report_final(argv, console.log)
  }
}

function worker_spawn () {
  var worker = cluster.fork()
  worker.iteration = 0
  worker.on('message', worker_results(worker))
}

function worker_exit (worker) {
  worker.send(['end'])
}

function worker_shutdown () {
  Object.keys(cluster.workers).forEach(function (id) {
    worker_exit(cluster.workers[id])
  })
}

/**
 * Signal all workers asking for data on transactions
 */
function worker_probe () {
  Object.keys(cluster.workers).forEach(function (id) {
    cluster.workers[id].send(['trans'])
  })
}

function rwWorkerJob (worker) {
  var option = {
    namespace: argv.namespace,
    set: argv.set,
    keyRange: argv.keyRange,
    rops: ROPS,
    wops: WOPS,
    binSpec: argv.binSpec
  }
  worker.iteration++
  worker.send(['run', option])
}

// @to-do this worker has to create index and then issue a query request
// once the index is created. After implementing the task completed API
// this can be enhanced for that.
function queryWorkerJob (worker, id) {
  var stmt = {}
  var queryConfig = argv.querySpec[id]
  if (queryConfig.qtype === 'Range') {
    stmt.filters = [aerospike.filter.range(queryConfig.bin, queryConfig.min, queryConfig.max)]
  } else if (queryConfig.qtype === 'Equal') {
    stmt.filters = [aerospike.filter.equal(queryConfig.bin, queryConfig.value)]
  }

  var options = {
    namespace: argv.namespace,
    set: argv.set,
    statement: stmt
  }
  worker.send(['query', options])
}

function scanWorkerJob (worker) {
  var options = {
    namespace: argv.namespace,
    set: argv.set,
    statement: argv.scanSpec
  }
  worker.send(['query', options])
}

/**
 * Collects the data related to transactions and prints it once the data is recieved from all workers.
 * (called per second)
 */
var counter = 0 // Number of times worker_results_interval is called
function worker_results_interval (worker, interval_worker_stats) {
  for (var i = 0; i < OP_TYPES; i++) {
    for (var j = 0; j < STATS; j++) {
      interval_stats[i][j] = interval_stats[i][j] + interval_worker_stats[i][j]
    }
  }
  if (++counter % argv.processes === 0) {
    stats.interval({
      'read': interval_stats[0],
      'write': interval_stats[1],
      'query': interval_stats[2],
      'scan': interval_stats[3]
    })
    if (!argv.silent) {
      print_interval_stats()
    }
  }
}

function print_interval_stats () {
  if (rwWorkers > 0) {
    logger.info('%s read(tps=%d timeouts=%d errors=%d) write(tps=%d timeouts=%d errors=%d) ',
      new Date().toString(), interval_stats[0][0], interval_stats[0][1], interval_stats[0][2],
      interval_stats[1][0], interval_stats[1][1], interval_stats[1][2])
  }
  if (queryWorkers) {
    logger.info('%s query(records = %d timeouts = %d errors = %d)',
      new Date().toString(), interval_stats[2][0], interval_stats[2][1], interval_stats[2][2])
  }
  if (scanWorkers) {
    logger.info('%s scan(records = %d timeouts = %d errors = %d)',
      new Date().toString(), interval_stats[3][0], interval_stats[3][1], interval_stats[3][2])
  }
}

function worker_results_iteration (worker, op_stats) {
  stats.iteration(op_stats)
  if (argv.iterations === undefined || worker.iteration < argv.iterations || argv.time !== undefined) {
    rwWorkerJob(worker)
  } else {
    worker_exit(worker)
  }
}

function worker_results (worker) {
  return function (message) {
    if (message[0] === 'stats') {
      worker_results_iteration(worker, message[1])
    } else if (message[0] === 'alert') {
      alerts.handleAlert(message[1].alert, message[1].severity)
    } else {
      worker_results_interval(worker, message[1])
    }
  }
}

/**
*  * Print config information
*   */
var keyrange = argv.keyRange.max - argv.keyRange.min

if (!argv.silent) {
  logger.info('host: ' + argv.host + ' port: ' + argv.port + ', namespace: ' + argv.namespace + ', set: ' + argv.set + ', worker processes: ' + argv.processes +
    ', keys: ' + keyrange + ', read: ' + ROPSPCT + '%, write: ' + WOPSPCT + '%')
}

/**
 * Flush out the current interval_stats and probe the worker every second.
 */
setInterval(function () {
  reset_interval_stats()
  worker_probe(cluster)
}, 1000)

/**
 * Reset the value of internal_stats.
 */
function reset_interval_stats () {
  interval_stats = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
}

// *****************************************************************************
// Event Listeners
// *****************************************************************************

process.on('exit', function () {
  logger.debug('Exiting.')
  if (exited === online) {
    return finalize()
  }
})

process.on('SIGINT', function () {
  logger.debug('Recevied SIGINT.')
})

process.on('SIGTERM', function () {
  logger.debug('Received SIGTERM.')
})

cluster.on('online', function (worker) {
  online++
  if (rwOnline < rwWorkers) {
    rwOnline++
    rwWorkerJob(worker)
  } else if (queryOnline < queryWorkers) {
    queryWorkerJob(worker, queryOnline)
    queryOnline++
  } else if (scanOnline < scanWorkers) {
    scanOnline++
    scanWorkerJob(worker)
  }
})

cluster.on('disconnect', function (worker, code, signal) {
  logger.debug('[worker: %d] Disconnected.', worker.process.pid, code)
})

cluster.on('exit', function (worker, code, signal) {
  if (code !== 0) {
    // non-ok status code
    logger.error('[worker: %d] Exited: %d', worker.process.pid, code)
    process.exit(1)
  } else {
    logger.debug('[worker: %d] Exited: %d', worker.process.pid, code)
    exited++
  }
  if (exited === online) {
    process.exit(0)
  }
})

// *****************************************************************************
// Setup Workers
// *****************************************************************************

if (argv.time !== undefined) {
  setTimeout(function () {
    reset_interval_stats()
    worker_probe(cluster)
    worker_shutdown(cluster)
  }, argv.time * 1000)
}

cluster.setupMaster({
  exec: 'worker.js',
  silent: false
})

stats.start()
for (var p = 0; p < argv.processes; p++) {
  worker_spawn()
}
