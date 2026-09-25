'use strict';
const runtime = require('../../../lib/media-receiver-runtime');
const renderer = require('../../../deploy/voice-stack/media-receiver-endpoints');
const { fixture } = require('./media-topology-fixture');

// Synthetic filesystem only. This never writes a host authority record.
function runtimeFixture() {
  const { config, contract } = fixture('v2');
  const files = new Map();
  const projection = renderer.renderReceiverEndpoints(config, contract);
  const identity = { bootId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', uid: 983,
    namespacePid: 100, startTicks: '7700', namespaceDevice: 4, namespaceInode: 9999 };
  const record = { schema: 'teleagent.media-receiver-runtime-admission.v1', generation: 'a'.repeat(64),
    imageId: `sha256:${'b'.repeat(64)}`, topologySchema: config.network.topology.schema,
    topologyDigest: projection.topologyDigest, effectivePolicyDigest: `sha256:${'c'.repeat(64)}`,
    rendererClosureDigest: `sha256:${'d'.repeat(64)}`, approvedRuntimeSources: {}, identity: structuredClone(identity),
    projection: structuredClone(projection), projectionDigest: projection.projectionDigest };
  for (const filename of runtime.REQUIRED_SOURCES) {
    const bytes = Buffer.from(`independently approved test bytes: ${filename}`);
    files.set(`/app/${filename}`, bytes);
    record.approvedRuntimeSources[filename] = runtime.digest(bytes);
  }
  let admissionReads = 0, onAdmissionRead = () => {}, unsafe = null;
  function publish() { files.set(runtime.ADMISSION_FILE, Buffer.from(runtime.canonical(record))); }
  publish();
  const metadata = (filename) => ({ uid: 0, gid: 0, mode: filename === unsafe ? 0o777 : 0o755, nlink: 1, dev: 1, ino: 10,
    size: files.get(filename)?.length ?? 0, isFile: () => files.has(filename), isDirectory: () => !files.has(filename) });
  const io = {
    lstatSync: metadata, fstatSync: metadata, openSync(filename) { if (!files.has(filename)) throw new Error('absent'); return filename; },
    closeSync() {}, statSync: () => ({ dev: identity.namespaceDevice, ino: identity.namespaceInode }),
    readFileSync(filename) {
      if (filename === runtime.ADMISSION_FILE) { admissionReads += 1; onAdmissionRead(admissionReads); }
      if (filename === '/proc/self/stat') return `${identity.namespacePid} (voice) S ${'0 '.repeat(18)}${identity.startTicks}`;
      if (filename === '/proc/self/status') return `Uid:\t${Array(4).fill(identity.uid).join('\t')}\n`;
      if (filename === '/proc/sys/kernel/random/boot_id') return `${identity.bootId}\n`;
      if (!files.has(filename)) throw new Error('absent');
      return files.get(filename);
    },
  };
  return { record, identity, files, io, publish, load: () => runtime.loadMediaReceiverRuntime({ io }),
    unsafe(filename) { unsafe = filename; }, onRead(callback) { onAdmissionRead = callback; admissionReads = 0; } };
}
module.exports = { runtimeFixture };
