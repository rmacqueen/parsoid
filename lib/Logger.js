"use strict";
require('./core-upgrade.js');

var LogData = require('./LogData.js').LogData,
	Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
	util = require('util'),
	defines = require('./mediawiki.parser.defines.js'),
	async = require('async');

/**
 * Multi-purpose logger. Supports different kinds of logging (errors,
 * warnings, fatal errors, etc.) and a variety of logging data (errors,
 * strings, objects).
 *
 * @class
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {boolean} dontRegisterDefaultBackend
 */
var Logger = function(env, opts) {
	if (!opts) { opts = {}; }
	var self = this,
	defaultLogLevels,
	escapedLogLevels,
	defaultRE,
	traceRE,
	debugRE,
	traceFlags,
	debugFlags;

	this._env = env;
	this._logRequestQueue = [];
	this._backends = new Map();

	// Set up regular expressions so that logTypes can be registered with
	// backends, and so that logData can be routed to the right backends.
	function fixLogType(logType) {
		return Util.escapeRegExp(logType) + "(\\/|$)";
	}
	defaultLogLevels = opts.logLevels || [];
	escapedLogLevels = defaultLogLevels.map(fixLogType);

	// DEFAULT: Combine all regexp-escaped default logTypes into a single regexp.
	defaultRE = new RegExp(defaultLogLevels.map(fixLogType).join("|"));
	// Register a default backend based on default logTypes.
	if (!opts.dontRegisterDefaultBackend) {
		this.registerBackend(defaultRE, self._defaultBackend);
	}

	// TRACE / DEBUG: Make trace / debugg regexp with appropriate postfixes,
	// depending on the command-line options passed in.
	traceFlags = this._env.conf.parsoid.traceFlags;
	debugFlags = this._env.conf.parsoid.debugFlags;
	function buildTraceOrDebugFlag(parsoidFlags, logType) {
		if (Array.isArray(parsoidFlags)) {
			var escapedFlags = parsoidFlags.map(Util.escapeRegExp);
			var combinedFlag = logType + "\/(" + escapedFlags.join("|") + ")(\\/|$)";
			escapedLogLevels.push(combinedFlag);
			return new RegExp(combinedFlag);
		} else {
			return null;
		}
	}

	// Register separate backend for tracing / debugging events.
	// Tracing and debugging use the same backend for now.
	if (!!traceFlags) {
		this.registerBackend(buildTraceOrDebugFlag(traceFlags, "trace"), self._defaultTracerBackend);
	}
	if (!!debugFlags) {
		this.registerBackend(buildTraceOrDebugFlag(debugFlags, "debug"), self._defaultTracerBackend);
	}

	// ALL LOGTYPES: Make regexp for all applicable logTypes (both set via the
	// options on env and passed in from the command line).
	this._testAllRE = new RegExp(escapedLogLevels.join("|"));
};

/**
 * @method
 *
 * Outputs logging and tracing information to different backends.
 * @param {String} logType
 */
Logger.prototype.log = function (logType) {
	try {
		var self = this;

		// XXX this should be configurable.
		// Tests whether logType matches any of the applicable logTypes
		// (including those set on env and the ones set via command line).
		if (this._testAllRE.test(logType)) {
			var logObject = Array.prototype.slice.call(arguments, 1);
			var logData = new LogData(this._env, logType, logObject);
			// If we are already processing a log request, but a log was generated
			// while processing the first request, processingLogRequest will be true.
			// We ignore all follow-on log events unless they are fatal. We put all
			// fatal log events on the logRequestQueue for processing later on.
			if (this.processingLogRequest) {
				if (/^fatal$/.test(logType)) {
					// Array.prototype.slice.call converts arguments to a real array
					// So that arguments can later be used in log.apply
					this._logRequestQueue.push(Array.prototype.slice.call(arguments));
				}
				return;
			// We weren't already processing a request, so processingLogRequest flag
			// is set to true. Then we send the logData to appropriate backends and
			// process any fatal log events that we find on the queue.
			} else {
				self.processingLogRequest = true;
				// Callback to routeToBackends forces logging of fatal log events.
				this._routeToBackends(logData, function(){
					self.processingLogRequest = false;
					if (self._logRequestQueue.length > 0) {
						self.log.apply(self, self._logRequestQueue.pop());
					}
				});
			}
		}
	} catch (e) {
		console.log(e.message);
		console.log(e.stack);
	}
};

/**
 * @method
 *
 * Registers a backend by adding it to the collection of backends.
 * @param {RegExp} logType
 * @param {Function} backend Backend to send logging / tracing info to.
 */
Logger.prototype.registerBackend = function (logType, backend) {
	var backendArray = [];
	var logTypeString;

	// Convert logType into a source string for a regExp that we can 
	// subsequently use to test logTypes passed in from Logger.log.
	if (logType instanceof RegExp) {
		logTypeString = logType.source;
	} else if (typeof(logType) === 'string') {
		logTypeString = "/^" + logType + "$/";
	} else {
		console.warn("LogType is neither a regular expression nor a string.");
		return;
	}

	// If we've already started an array of backends for this logType,
	// add this backend to the array; otherwise, start a new array
	// consisting of this backend.
	if (!this._backends.has(logTypeString)) {
		backendArray.push(backend);
	} else {
		backendArray = this._backends.get(logTypeString);
		if (backendArray.indexOf(backend) === -1) {
			backendArray.push(backend);
		}
	}
	this._backends.set(logTypeString, backendArray);
};

/**
 * @method
 *
 * Optional default backend.
 * @param {LogData} logData
 * @param {Function} cb Callback for async.parallel.
 */
Logger.prototype._defaultBackend = function(logData, cb) {
	try {
		var logType = logData.logType;
		var msg = logData.locationMsg() + ': ' + logData.msg();
		msg += '\n' + logData.stack();

		if (msg) {
			console.warn(msg);
		}
	} catch (e) {
		console.error("Error in defaultBackend: " + e);
		return;
	} finally {
		cb();
	}
};

/**
 * @method
 *
 * Optional default tracing and debugging backend.
 * @param {LogData} logData
 * @param {Function} cb Callback for async.parallel.
 */
Logger.prototype._defaultTracerBackend = function(logData, cb) {
	try {
		var logType = logData.logType;
		var msg = '';
		// indent by number of slashes
		var level = logType.match(/\//g).length - 1;
		msg += '  '.repeat(level);

		// XXX: could shorten or strip trace/ logType prefix in a pure
		// trace logger
		msg += logType;
		// Fixed-width type column so that the messages align
		var typeColumnWidth = 30;
		msg = msg.substr(0, typeColumnWidth);
		msg += ' '.repeat(typeColumnWidth - msg.length);
		msg += ': ' + logData.msg();

		if (msg) {
			console.warn(msg);
		}
	} catch (e) {
		console.error("Error in tracerBackend: " + e);
		return;
	} finally {
		cb();
	}
};

/**
 * @method
 *
 * Gets all registered backends that apply to a particular logType.
 * @param {LogData} logData
 */
Logger.prototype._getApplicableBackends = function(logData) {
	var applicableBackends = [];
	var logType = logData.logType;
	var savedBackends = this._backends;

	// Pulls out any backendArrays corresponding to the logType
	savedBackends.forEach(function(backendArray, logTypeString) {
		// Convert the stored logTypeString back into a regExp, in case
		// it applies to multiple logTypes (e.g. /fatal|error/).
		if (new RegExp(logTypeString).test(logType)) {
			// Extracts relevant backends and pushes them onto applicableBackends
			backendArray.forEach( function(backend) { applicableBackends.push(function(cb){
					try {
						backend(logData, function(){
							cb(null);
						});
					} catch (e) {
						cb(null);
					}
				});
			});
		}
	});
	return applicableBackends;
};

/**
 * @method
 *
 * Routes log data to backends. If logType is fatal, exits process
 * after logging to all backends.
 * @param {LogData} logData
 * @param {Function} cb
 */
Logger.prototype._routeToBackends = function(logData, cb) {
	var applicableBackends = this._getApplicableBackends(logData);
	// If the logType is fatal, exits the process after logging
	// to all of the backends.
	// Additionally runs a callback that looks for fatal
	// events in the queue and logs them.
	async.parallel(applicableBackends, function(){
		if (/^fatal$/.test(logData.logType)) {
			process.exit(1);
		}
		cb();
	});
};


if (typeof module === "object") {
	module.exports.Logger = Logger;
}