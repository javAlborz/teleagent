'use strict';
const { assertMediaReceiverRuntime } = require('../../lib/media-receiver-runtime');

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

function loadMediaControlEndpoints(settings = process.env, runtime = null) {
  if (runtime) {
    const projection = assertMediaReceiverRuntime(runtime);
    return Object.freeze({
      drachtio: Object.freeze({ host: projection.voiceEnvironment.DRACHTIO_HOST, port: 9022 }),
      freeswitch: Object.freeze({ host: projection.freeswitchControlTarget.address, port: 8021 }),
    });
  }
  return Object.freeze({
    drachtio: exactEndpoint(settings, 'DRACHTIO_HOST', 'DRACHTIO_PORT', 9022),
    freeswitch: exactEndpoint(settings, 'FREESWITCH_HOST', 'FREESWITCH_PORT', 8021),
  });
}

function buildFreeswitchConnectionOptions(endpoint, secret, runtime = null) {
  if (runtime) {
    const projection = assertMediaReceiverRuntime(runtime);
    if (endpoint?.host !== projection.freeswitchControlTarget.address || endpoint?.port !== 8021) {
      throw new MediaControlEndpointError('FreeSWITCH target differs from admitted media generation.');
    }
    const reverse = projection.reverseEsl;
    // The pinned library supports these fixed public options. Cross-namespace
    // peer restriction is supplied by the admitted v2 kernel policy. Native
    // mrf has no pre-parse peer hook; the same-authority voice workload can
    // still connect locally and already holds the ESL control credential.
    return Object.freeze({ address: endpoint.host, port: 8021, secret, profile: 'drachtio_mrf',
      listenAddress: reverse.listenAddress, listenPort: reverse.listenPort,
      advertisedAddress: reverse.advertisedAddress, advertisedPort: reverse.advertisedPort });
  }
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
