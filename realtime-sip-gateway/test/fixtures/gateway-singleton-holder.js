import { acquireGatewaySingleton } from '../../src/gateway-singleton.js';

const singleton = acquireGatewaySingleton({ stateDatabasePath: process.argv[2] });
process.send?.({ status: 'acquired' });

const release = () => {
  singleton.release();
  process.exit(0);
};
process.once('SIGTERM', release);
process.once('SIGINT', release);
setInterval(() => {}, 60_000);
