#!/usr/bin/env node
'use strict';

const { acquireBrokerSingletonLock } = require('../../server');

let lock = null;

process.on('message', (message) => {
  if (message === 'go') {
    try {
      lock = acquireBrokerSingletonLock(process.argv[2], {
        expectedUid: process.geteuid(),
      });
      process.send?.({ status: 'acquired' });
    } catch (error) {
      process.send?.({
        status: error.message.includes('kernel-backed singleton lock') ? 'blocked' : 'error',
        error: error.message,
      });
      process.exitCode = error.message.includes('kernel-backed singleton lock') ? 0 : 1;
    }
  } else if (message === 'release' && lock) {
    lock.release();
    process.exit(0);
  }
});
