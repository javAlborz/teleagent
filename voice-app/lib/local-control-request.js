'use strict';

const localUnixRequests = new WeakSet();

function admitLocalUnixRequest(req) {
  if (!req || !req.socket || req.socket.remoteAddress !== undefined ||
      req.socket.localAddress !== undefined) {
    throw new Error('local control request is not a Unix socket');
  }
  localUnixRequests.add(req);
}

function isLocalUnixRequest(req) {
  return Boolean(req && localUnixRequests.has(req));
}

module.exports = { admitLocalUnixRequest, isLocalUnixRequest };
