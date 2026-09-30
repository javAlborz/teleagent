'use strict';

const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const { loadOwnerAuthority, protectedRead } = require('./owner-authority-config');
const { sessionError } = require('./owner-session-endpoint');
const { createPbxArmVerifier, createPbxEvidenceIssuer } = require('../lib/pbx-approval-protocol');
const { createPbxApprovalAttester } = require('../lib/pbx-approval-attester');
const { createSqlitePbxApprovalAttesterStore } = require('../lib/pbx-approval-attester-store');
const { PbxAriClient } = require('./pbx-ari-client');
const { PbxAriApprovalAdapter, PbxAriCallCatalog } = require('./pbx-ari-approval-adapter');
const { PbxAriCallRouter } = require('./pbx-ari-call-router');
const { PbxPromptRenderer } = require('./pbx-prompt-renderer');
const { createPbxLocalSpeechSynthesizer } = require('./pbx-local-speech');
const { loadPbxAttesterBoundary } = require('./pbx-attester-boundary');
const { createPbxAttesterApi, PbxAttesterControlStore } = require('./pbx-attester-api');
const { createPbxAttesterServer, SOCKET_PATH } = require('./pbx-attester-http');
const { inheritedSocketFd, assertInheritedSocketBoundary, lookupSystemGroupGid,
  acquireWorkerSessionSingletonLock, assertCredentialFreeEnvironment } = require('./worker-session-broker-service');
const STATE = '/var/lib/teleagent-pbx-attester';
const AUDIO = '/var/lib/teleagent-pbx-prompts';
const ENABLE = '/etc/teleagent/pbx-attester/ENABLE';

async function startPbxAttester() {
  assertCredentialFreeEnvironment();
  if (process.getuid() === 0 || os.userInfo().username !== 'teleagent-pbx-attester') throw sessionError('PBX_SERVICE_IDENTITY_INVALID');
  const state = fs.lstatSync(STATE);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700 ||
      fs.realpathSync(STATE) !== STATE) throw sessionError('PBX_SERVICE_STORAGE_UNSAFE');
  const authority = loadOwnerAuthority('pbx');
  const boundary = loadPbxAttesterBoundary(authority.epoch);
  const assertBoundary = () => {
    authority.assertCurrent(); boundary.assertCurrent();
    if (protectedRead(ENABLE) !== `${authority.epoch}\n`) throw sessionError('PBX_SERVICE_DISABLED');
  };
  assertBoundary();
  const fd = inheritedSocketFd(process.env, process.pid, 'pbx-attester');
  assertInheritedSocketBoundary(fd, SOCKET_PATH, 0, lookupSystemGroupGid(), { allowTestPath: true });
  const lock = acquireWorkerSessionSingletonLock(`${STATE}/lifetime.sqlite`, { allowTestPath: true });
  const ari = new PbxAriClient({ username: 'teleagent-attester',
    password: protectedRead('/etc/teleagent/pbx-attester/ari-password', { secret: true }).trim() });
  let db; let router; let server; let adapter;
  try {
    const filename = `${STATE}/attestations.sqlite`;
    try { const file = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); fs.closeSync(file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const st = fs.lstatSync(filename);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) throw sessionError('PBX_SERVICE_STORAGE_UNSAFE');
    db = new Database(filename); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
    const controlStore = new PbxAttesterControlStore(db);
    if (controlStore.isLocked()) throw sessionError('PBX_ATTESTER_LOCKED');
    const calls = new PbxAriCallCatalog({ ari, pbxInstanceId: boundary.pbxInstanceId });
    const renderer = new PbxPromptRenderer({ directory: AUDIO,
      synthesize: createPbxLocalSpeechSynthesizer({ assertBoundary }) });
    adapter = new PbxAriApprovalAdapter({ ari, calls, renderer, assertPbxBoundary: assertBoundary });
    router = new PbxAriCallRouter({ ari, calls, approvalAdapter: adapter, assertPbxBoundary: assertBoundary });
    const armVerifier = createPbxArmVerifier({ publicKeys: authority.controllerArmPublicKeys });
    const attester = createPbxApprovalAttester({ armVerifier,
      evidenceIssuer: createPbxEvidenceIssuer(authority), adapter, store: createSqlitePbxApprovalAttesterStore(db) });
    const api = createPbxAttesterApi({ calls, attester, armVerifier, adapter, router, assertBoundary, controlStore,
      epoch: authority.epoch, assertReady() {
        ari.assertEpoch(ari.epoch);
        if (router.locked) throw sessionError('PBX_ATTESTER_LOCKED');
      } });
    await ari.connect(); assertBoundary();
    server = createPbxAttesterServer(api);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ fd, exclusive: false }, resolve); });
    return { async shutdown() {
      adapter.cancel(); await router.close(); ari.close();
      await new Promise((resolve) => server.close(resolve)); db.close(); lock.release();
    } };
  } catch (error) {
    adapter?.cancel(); if (router) await router.close().catch(() => {});
    ari.close(); server?.close(); db?.close(); lock.release(); throw error;
  }
}
if (require.main === module) {
  startPbxAttester().then((runtime) => {
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return; stopping = true;
      void runtime.shutdown().then(() => process.exit(0), () => process.exit(1));
    });
  }).catch(() => { console.error('PBX_ATTESTER_STARTUP_REFUSED'); process.exitCode = 1; });
}
module.exports = { startPbxAttester };
