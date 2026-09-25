'use strict';

const axios = require('axios');

const CONTROLLER_SOCKET = '/run/teleagent-controller/controller.sock';

function requestOptions(options = {}, socketPath = CONTROLLER_SOCKET) {
  return {
    ...options,
    socketPath,
    proxy: false,
    maxRedirects: 0,
  };
}

// Every controller operation uses the same protected receiver. A missing socket
// is an error; there is no TCP or proxy fallback, including for panic/recovery.
function createControllerHttpClient(client = axios, socketPath = CONTROLLER_SOCKET) {
  return Object.freeze({
    get(url, options) { return client.get(url, requestOptions(options, socketPath)); },
    post(url, body, options) { return client.post(url, body, requestOptions(options, socketPath)); },
  });
}

module.exports = { ...createControllerHttpClient(), CONTROLLER_SOCKET, createControllerHttpClient };
