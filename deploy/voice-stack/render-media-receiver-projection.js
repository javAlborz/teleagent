#!/usr/bin/env node
'use strict';

// Credential-free release renderer for the independent host runtime publisher.
// The host supplies its protected network configuration and application contract
// through stdin; this program never reads private host state or opens a socket.
const fs = require('node:fs');
const { renderReceiverEndpoints } = require('./media-receiver-endpoints');
const { canonical } = require('./media-application-boundary');

function render(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 524288) throw Error('bounded input required');
  const request = JSON.parse(source);
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Object.keys(request).sort().join(' ') !== 'applicationContract networkConfig' ||
      source.trim() !== canonical(request)) throw Error('canonical input required');
  const projection = renderReceiverEndpoints(request.networkConfig, request.applicationContract);
  const result = canonical(projection);
  if (Buffer.byteLength(result) > 524288) throw Error('bounded output required');
  return result;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw Error('no arguments accepted');
    process.stdout.write(`${render(fs.readFileSync(0, 'utf8'))}\n`);
  } catch {
    process.stderr.write('private media receiver projection refused\n');
    process.exitCode = 77;
  }
}

module.exports = { render };
