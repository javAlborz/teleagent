'use strict';
const { assertMediaReceiverRuntime } = require('../../lib/media-receiver-runtime');
let runtime = null;

function configureMediaPlayback(admission) {
  assertMediaReceiverRuntime(admission);
  if (runtime && runtime !== admission) throw new Error('media playback generation cannot be replaced in place');
  runtime = admission;
}
function playbackUrl(kind, filename) {
  const { normalizeMediaPath } = require('./http-server');
  if (!['audio-files', 'static'].includes(kind) || !normalizeMediaPath(filename, { nested: kind === 'static' })) {
    throw new Error('invalid confined media playback path');
  }
  // The legacy loopback path remains usable by source/unit consumers. The
  // production entrypoint requires host admission and configures this module
  // before it connects any media client or registers a call handler.
  const base = runtime ? assertMediaReceiverRuntime(runtime).privateHttpAudio.baseUrl : 'http://127.0.0.1:3000';
  return `${base}/${kind}/${filename.split('/').map(encodeURIComponent).join('/')}`;
}
module.exports = { configureMediaPlayback, playbackUrl };
