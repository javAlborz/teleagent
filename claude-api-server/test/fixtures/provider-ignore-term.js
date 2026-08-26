'use strict';

process.on('SIGTERM', () => {
  // Deliberately ignore the graceful termination request. The provider
  // supervisor must escalate to SIGKILL and reap the whole launch group.
});

process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`);
setInterval(() => {}, 60_000);
