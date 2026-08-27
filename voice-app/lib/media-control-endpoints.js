'use strict';

class MediaControlEndpointError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaControlEndpointError';
    this.code = 'MEDIA_CONTROL_ENDPOINT_INVALID';
  }
}

function exactEndpoint(settings, hostName, portName, expectedPort) {
  const host = settings[hostName] === undefined || settings[hostName] === ''
    ? '127.0.0.1'
    : String(settings[hostName]);
  const port = settings[portName] === undefined || settings[portName] === ''
    ? String(expectedPort)
    : String(settings[portName]);
  if (host !== '127.0.0.1' || port !== String(expectedPort)) {
    throw new MediaControlEndpointError(
      `${hostName} and ${portName} must use the exact reviewed loopback endpoint.`,
    );
  }
  return Object.freeze({ host, port: expectedPort });
}

function loadMediaControlEndpoints(settings = process.env) {
  return Object.freeze({
    drachtio: exactEndpoint(settings, 'DRACHTIO_HOST', 'DRACHTIO_PORT', 9022),
    freeswitch: exactEndpoint(settings, 'FREESWITCH_HOST', 'FREESWITCH_PORT', 8021),
  });
}

function buildFreeswitchConnectionOptions(endpoint, secret) {
  if (endpoint?.host !== '127.0.0.1' || endpoint?.port !== 8021) {
    throw new MediaControlEndpointError(
      'FreeSWITCH reverse control must use the exact reviewed loopback endpoint.',
    );
  }
  return Object.freeze({
    address: endpoint.host,
    port: endpoint.port,
    secret,
    // drachtio-fsmrf defaults this reverse ESL listener to the first
    // non-loopback interface. FreeSWITCH is host-local, so bind and advertise
    // only the already-validated loopback media boundary.
    listenAddress: endpoint.host,
    advertisedAddress: endpoint.host,
  });
}

module.exports = {
  MediaControlEndpointError,
  buildFreeswitchConnectionOptions,
  loadMediaControlEndpoints,
};
