'use strict';

const {
  assertInheritedSocketBoundary,
  listenOnInheritedSocket,
} = require('../../worker-session-broker-service');

const socketPath = process.argv[2];

(async () => {
  assertInheritedSocketBoundary(3, socketPath, process.getuid(), process.getgid(), {
    allowTestPath: true,
  });
  const server = await listenOnInheritedSocket(3, socketPath);
  process.stdout.write(`${socketPath}\n`);
  await new Promise((resolve) => server.close(resolve));
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
