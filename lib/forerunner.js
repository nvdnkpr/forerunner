// forerunner.js
// central manager for all forerunner-workers

// requires
var io = require('socket.io');
// oh look, underscore. I wonder if anyone else uses this...
var _ = require('underscore');
var async = require('async');

// function hooks to notify works about fun stuff
var _preHooks = {};
var _stagedHooks = {};
var _progressHooks = {};
var _postHooks = {};
var _failedHooks = {};

// record of workers and what done
var _currentWorker = {};
var _currentWorkerAbilities = {};
var _jobsOnSocket = {};

// module level vars
var queueObject = null;
var storeObject = null;
var logger = null;
var moduleOpts = null;

// defaults for many things
var _forerunnerDefaults = {
  // natural base is a good port to use
  port: 2718,
  // no job state stored by default, default to process memory
  queue: require('./builtins/queue/memory_queue'),
  // and a console save
  store: require('./builtins/store/memory_store'),
  flushCount: 10,
  flushInterval: 5000,
  // jobs can fail once
  maxFailCount: 1,
  logger: console,
  loadFromStore: false
};

// creates a new forerunner
function forerunner(opts) {
  if (!opts) {
    opts = {};
  }
  // extent the config
  opts = _.extend(_forerunnerDefaults, opts);
  moduleOpts = opts;

  // set up store and saves
  queueObject = opts.queue;
  storeObject = opts.store;
  logger = opts.logger;

  logger.info('Forerunner - started with these options: ');
  logger.info(JSON.stringify(opts, null, 2));

  updateFlushIntervalTime(moduleOpts.flushInterval)

  // start listening
  var managerSocket = io.listen(opts.port);

  // if we want to load the queue from the store
  if (opts.loadFromStore) {
    logger.info('Forerunner - load from store option set, going to EMPTY the queue and fill it with jobs from the store');
    storeObject.getQueue(function(err, jobs) {
      if (err) {
        logger.error('Forerunner - failed to queue from store, NOT emptying queue');
        return;
      }
      queueObject.empty(function(err) {
        if (err) {
          logger.error('Forerunner - failed to empty queue, NOT filling it with job data');
          return;
        }
        _.each(jobs, function(jobObject) {
          queueObject.push(jobObject.id, jobObject.type, jobObject.data, function(err) {
            if (err) {
              logger.error('Forerunner - failed to push job to queue from the store');
              logger.error(JSON.stringify(err, null, 2));
              return callback(err);
            }
            logger.info('Forerunner - loaded stored job into queue id ' + jobObject.id);
          });
        });
      });
    });
  }

  // new connection to the manager
  managerSocket.on('connection', function(socket) {
    // keep track of the socket
    var socketId = socket.id;
    _currentWorker[socketId] = socket;

    // after the manifest is sent, record it
    socket.on('manifest', function(data) {
      logger.info('Forerunner - recived manifest from worker on socket ' + socketId);
      if (data.manifest && _.isArray(data.manifest)) {
        _currentWorkerAbilities[socketId] = data.manifest;
      } else {
        // wat
        logger.error('Worker connected, but did not send a proper manifest');
        logger.log(data);
      }
    });

    // and when it disconnects, remove it
    socket.on('disconnect', function() {
      logger.info('Forerunner - worker disconnected socketId: ' + socketId);
      // if the socket goes down, all jobs are lost
      invalidateJobsOnSocket(socketId, function() {
        // dont flush as there are no new workers!
      });
    });

    socket.on('job_complete', function(payload) {
      var jobId = payload.id;
      var jobResult = payload.result;
      var jobType = payload.type;

      logger.info('Forerunner - job complete ' + jobType + ':' + jobId);

      removeJobFromSocket(socketId, jobId);
      storeObject.complete(jobId, jobResult, function(err) {
        if (err) {
          console.error(err);
        }
        alertJobComplete(jobType, jobId, jobResult);
      });
    });

    socket.on('job_progress', function(payload) {
      var jobId = payload.id;
      var jobType = payload.type;
      var progress = payload.progress;

      logger.info('Forerunner - job progress ' + jobId + ' ' + progress);

      alertJobProgress(jobType, jobId, progress);

      storeObject.progress(jobId, progress, function(err) {
        if (err) {
          logger.error('Forerunner store failed to record job progress');
          logger.error(err);
        }
      });
    });

    socket.on('job_failed', function(payload) {
      var jobId = payload.id;
      var message = payload.message;

      logger.error('Forerunner - job failed ' + jobId + ' ' + message);

      var job = removeJobFromSocket(socketId, jobId);
      storeObject.countFailed(jobId, message, function(err, failCount) {
        alertJobFailed(job.type, jobId, message);
        if (moduleOpts.maxFailCount <= 0 || failCount < moduleOpts.maxFailCount) {
          // requeue the job
          queueObject.requeue(jobId, job.type, job.payload, function(err) {
            if (err) {
              logger.error('Forerunner - FAILED TO REQUEUE JOB! THE JOB WAS LOST FROM THE QUEUE!');
              logger.error(JSON.stringify(err, null, 2));
            }
            logger.info('Forerunner - job re-queued ' + jobId);
          });
        } else {
          logger.error('Forerunner - job failed too many times ' + jobId);
          storeObject.failed(jobId, function(err) {
            if (err) {
              console.error(err);
            }
          });
        }
      });
    });
  });
}
module.exports.start = forerunner;

//
/// User hooks for job state
//

function onCreated(jobType, fn) {
  pushFunctionOntoHook(_preHooks, jobType, fn);
}
module.exports.onCreated = onCreated;

function onStaged(jobType, fn) {
  pushFunctionOntoHook(_stagedHooks, jobType, fn);
}
module.exports.onStaged = onStaged;

function onProgress(jobType, fn) {
  pushFunctionOntoHook(_progressHooks, jobType, fn);
}
module.exports.onProgress = onProgress;

function onComplete(jobType, fn) {
  pushFunctionOntoHook(_postHooks, jobType, fn);
}
module.exports.onComplete = onComplete;

function onFailed(jobType, fn) {
  pushFunctionOntoHook(_failedHooks, jobType, fn);
}
module.exports.onFailed = onFailed;

// utilities to call hooked functions
function alertJobCreate(jobType, jobId, jobData) {
  callHookedFunctions(_preHooks, jobType, [jobId, jobData]);
}

function alertJobStaged(jobType, jobId, jobData) {
  callHookedFunctions(_stagedHooks, jobType, [jobId, jobData]);
}

function alertJobProgress(jobType, jobId, jobProgress) {
  callHookedFunctions(_progressHooks, jobType, [jobId, jobProgress]);
}

function alertJobComplete(jobType, jobId, jobResult) {
  callHookedFunctions(_postHooks, jobType, [jobId, jobResult]);
}

function alertJobFailed(jobType, jobId, message) {
  callHookedFunctions(_failedHooks, jobType, [jobId, message]);
}

//
/// Plugin logic
//

function regisiterPlugin(plug) {
  var self = this;
  plug.forerunner = this;

  var hooks;
  if (typeof plug.created === 'function') {
    hooks = plug.created();
    _.each(hooks, function(fn, job) {
      self.onCreated(job, fn);
    });
  }
  if (typeof plug.staged === 'function') {
    hooks = plug.staged();
    _.each(hooks, function(fn, job) {
      self.onStaged(job, fn);
    });
  }
  if (typeof plug.progress === 'function') {
    hooks = plug.progress();
    _.each(hooks, function(fn, job) {
      self.onProgress(job, fn);
    });
  }
  if (typeof plug.completed === 'function') {
    hooks = plug.completed();
    _.each(hooks, function(fn, job) {
      self.onCreated(job, fn);
    });
  }
  if (typeof plug.failed === 'function') {
    hooks = plug.failed();
    _.each(hooks, function(fn, job) {
      self.onFailed(job, fn);
    });
  }
}
module.exports.regisiterPlugin = regisiterPlugin;

//
/// User functions for job def and control
//

// asks the forerunner to assign a job
// he will if he can
function assignJob(jobType, rawData, callback) {
  if (!callback) {
    // noop
    callback = function() {};
  }

  storeObject.create(jobType, rawData, function(err, jobId, jobData) {
    if (err) {
      logger.error('Forerunner - failed to create job in store');
      logger.error(JSON.stringify(err, null, 2));
      return callback(err);
    }
    logger.info('Forerunner - created new job of type and id ' + jobType + ' ' + jobId);

    // create a new jobId for the job
    queueObject.push(jobId, jobType, jobData, function(err) {
      if (err) {
        logger.error('Forerunner - failed to push job to queue');
        logger.error(JSON.stringify(err, null, 2));
        return callback(err);
      }
      logger.info('Forerunner - queued job of type:id ' + jobType + ':' + jobId);

      alertJobCreate(jobType, jobId, jobData);
      // callback right when it is queued!
      callback(null, jobId, jobData);
    });
  });

}
module.exports.assignJob = assignJob;

//
/// Private, internal affairs.
//

function pushFunctionOntoHook(hooks, jobType, fn) {
  if (!_.isArray(jobType)) {
    jobType = [jobType];
  }
  _.each(jobType, function(type) {
    if (!hooks[type]) {
      hooks[type] = [];
    }
    hooks[type].push(fn);
  });
}

function callHookedFunctions(hooks, jobType, argsArray) {
  if (hooks[jobType]) {
    for (var i = 0; i < hooks[jobType].length; i++) {
      hooks[jobType][i].apply(this, argsArray);
    }
  }
}

// a socket has dropped, count all jobs as failed
function invalidateJobsOnSocket(socketId, callback) {
  logger.info('Forerunner - invalidating jobs on socket: ' + socketId);
  // clone the jobs on the socket
  if (_jobsOnSocket[socketId]) {
    var jobs = _jobsOnSocket[socketId].slice(0);
    async.each(jobs, function(jobObject, cb) {
      storeObject.countFailed(jobObject.id, 'socket_disconnect', function(err, failCount) {
        alertJobFailed(jobObject.type, jobObject.id, 'socket_disconnect');
        if (moduleOpts.maxFailCount <= 0 || failCount < moduleOpts.maxFailCount) {
          // nada
          // we don't need no DeMorgans law here
          queueObject.requeue(jobObject.id, jobObject.type, jobObject.payload, function(err) {
            if (err) {
              logger.error('Forerunner - FAILED TO REQUEUE JOB! THE JOB WAS LOST FROM THE QUEUE!');
              logger.error(JSON.stringify(err, null, 2));
            }
          });
        } else {
          storeObject.failed(jobObject.id, function(err) {
            if (err) {
              console.error(err);
            }
          });
        }
        cb();
      });
    }, function() {
      delete _currentWorker[socketId];
      delete _jobsOnSocket[socketId];
      callback();
    });
  }
}

// finds a job on a worker and deletes it
function removeJobFromSocket(socketId, jobId) {
  var jobIdList = _.pluck(_jobsOnSocket[socketId], 'id');
  var index = jobIdList.indexOf(jobId);
  return _jobsOnSocket[socketId].splice(index, 1)[0];
}

// tries to see if there is a free worker for the job type
function getFreeWorker(jobType) {
  // first get the free workers, by socket id
  var allWorkers = Object.keys(_currentWorker);
  var busyWorkers = []; //Object.keys(_jobsOnSocket);
  _.each(_jobsOnSocket, function(jobs, workerId) {
    // TODO: eventually this will be more flexible
    // and allow for many jobs per worker
    if (jobs.length > 0) {
      busyWorkers.push(workerId);
    }
  });
  var freeWorkers = _.difference(allWorkers, busyWorkers);
  for (var i = 0; i < freeWorkers.length; i++) {
    // only assign to the worker if we know what it can do
    if (_currentWorkerAbilities[freeWorkers[i]] && _currentWorkerAbilities[freeWorkers[i]].indexOf(jobType) !== -1) {
      // just return the first open worker for the job type
      return freeWorkers[i];
    }
  }
}

// assigns a job id to a worker
function assignJobToWorker(jobId, jobType, workerId, payload, callback) {
  if (!_jobsOnSocket[workerId]) {
    _jobsOnSocket[workerId] = [];
  }
  alertJobStaged(jobType, jobId, payload);
  _jobsOnSocket[workerId].push({id: jobId, type: jobType, payload: payload});
  _currentWorker[workerId].emit('new_job', {id: jobId, type: jobType, payload: payload}, callback);
}

//
/// Queue flusing control
//

var flushIsRunning = false;
var flushIntervalId;

function updateFlushIntervalTime(inverval) {
  if (flushIntervalId) {
    clearInverval(flushIntervalId);
  }
  flushIntervalId = setInterval(function() {
    flushQueue();
  }, inverval)
}

function flushQueue() {
  // only allow one flush as a time (because there is a lot of async stuff flying around)
  if (!flushIsRunning) {
    flushIsRunning = true;
    logger.info('Forerunner - flushing queue');
    queueObject.each(moduleOpts.flushCount, function(jobId, jobType, jobData) {
      var workerId = getFreeWorker(jobType);
      if (workerId) {
        logger.info('Forerunner - worker found assigning job ' + jobId);
        assignJobToWorker(jobId, jobType, workerId, jobData, function(err, ack) {
          if (err) {
            logger.error('Forerunner - Failed to assign job to worker: ' + jobId);
            logger.error(JSON.stringify(err, null, 2));
          } else {
            logger.info('Forerunner - job successfully assigned to worker ' + jobId);
          }
        });
      } else {
        logger.info('Forerunner - could not find worker for type ' + jobType);
        // put it back in the queue
        queueObject.requeue(jobId, jobType, jobData, function(err) {
          if (err) {
            logger.error('Forerunner - FAILED TO REQUEUE JOB! THE JOB WAS LOST FROM THE QUEUE!');
            logger.error(JSON.stringify(err, null, 2));
          }
        });
      }
    }, function(err) {
      if (err) {
        logger.error('Forerunner - error when flushing queue');
        logger.error(JSON.stringify(err, null, 2));
      }
      logger.info('Forerunner - finished flushing queue');
      flushIsRunning = false;
    });
  } else {
    logger.info('Forerunner - tried to flush queue, but it is already flushing');
    logger.info('Forerunner - adjust your flushCount or flushInverval params?');
  }
};
