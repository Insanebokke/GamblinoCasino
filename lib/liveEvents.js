'use strict';
const { EventEmitter } = require('events');

/* Single shared emitter for broadcasting live bet events to all SSE connections.
   Max listeners raised to handle many concurrent browser connections. */
const emitter = new EventEmitter();
emitter.setMaxListeners(500);

module.exports = emitter;
