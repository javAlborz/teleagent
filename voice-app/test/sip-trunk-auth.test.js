'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTH_REALM,
  CALLBACK_AUTH_USERNAME,
  CALLBACK_PASSWORD_FILE,
  INGRESS_AUTH_USERNAME,
  INGRESS_PASSWORD_FILE,
  createInboundDigestAuthenticator,
  hasSafeCredentialFileMetadata,
  loadSipTrunkSecurityConfig,
  readCredentialFile,
} = require('../lib/sip-trunk-auth');

const INGRESS_PASSWORD = 'ingress-0123456789abcdef0123456789abcdef';
const CALLBACK_PASSWORD = 'callback-fedcba9876543210fedcba9876543210';

function sipDigest(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function challengeResponse() {
  const calls = [];
  return {
    calls,
    response: {
      send(status, options) { calls.push({ status, options }); },
    },
  };
}

function parseChallenge(value) {
  const fields = {};
  for (const match of value.matchAll(/([a-z]+)=(?:"([^"]*)"|([^,\s]+))/gi)) {
    fields[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return fields;
}

function request(authorization = '') {
  return {
    method: 'INVITE',
    uri: 'sip:7@127.0.0.1:5070',
    get(name) { return name === 'Authorization' ? authorization : ''; },
  };
}

function authorizationFor(challenge, { password = INGRESS_PASSWORD, cnonce = 'abcdef0123456789' } = {}) {
  const nc = '00000001';
  const uri = 'sip:7@127.0.0.1:5070';
  const ha1 = sipDigest(`${INGRESS_AUTH_USERNAME}:${AUTH_REALM}:${password}`);
  const ha2 = sipDigest(`INVITE:${uri}`);
  const response = sipDigest(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return 'Digest ' + [
    `username="${INGRESS_AUTH_USERNAME}"`,
    `realm="${AUTH_REALM}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    'algorithm=MD5',
    `opaque="${challenge.opaque}"`,
    'qop=auth',
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
  ].join(', ');
}

test('startup SIP security loads two distinct fixed credentials and binds callback auth to the exact route', () => {
  const reads = [];
  const security = loadSipTrunkSecurityConfig({
    env: {
      SIP_TRUNK_HOST: '127.0.0.1',
      SIP_TRUNK_PORT: '5060',
      SIP_TRUNK_TRANSPORT: 'udp',
    },
    credentialReader(filename) {
      reads.push(filename);
      return filename === INGRESS_PASSWORD_FILE ? INGRESS_PASSWORD : CALLBACK_PASSWORD;
    },
  });

  assert.deepEqual(reads, [INGRESS_PASSWORD_FILE, CALLBACK_PASSWORD_FILE]);
  assert.equal(security.outboundRouting.buildSipUri('1001'), 'sip:1001@127.0.0.1:5060;transport=udp');
  assert.deepEqual(security.outboundRouting.getCallbackAuth(), {
    username: CALLBACK_AUTH_USERNAME,
    password: CALLBACK_PASSWORD,
  });
  assert.equal(Object.values(security.outboundRouting).includes(CALLBACK_PASSWORD), false);
});

test('missing, weak, placeholder, or reused SIP trunk credentials fail startup', () => {
  const env = {
    SIP_TRUNK_HOST: '127.0.0.1',
    SIP_TRUNK_PORT: '5060',
    SIP_TRUNK_TRANSPORT: 'udp',
  };
  for (const value of [
    '',
    'short',
    'replace-with-a-real-secret-value-please',
    'unsafe;config-injection-0123456789abcdef',
  ]) {
    assert.throws(
      () => loadSipTrunkSecurityConfig({ env, credentialReader: () => value }),
      /credential/
    );
  }
  assert.throws(
    () => loadSipTrunkSecurityConfig({ env, credentialReader: () => INGRESS_PASSWORD }),
    /must be distinct/
  );
});

test('SIP ingress uses one-use high-entropy digest admission and rejects replay or a wrong secret', () => {
  const authenticator = createInboundDigestAuthenticator({ password: INGRESS_PASSWORD });
  const first = challengeResponse();
  assert.equal(authenticator.authenticateInvite(request(), first.response), null);
  assert.equal(first.calls[0].status, 401);
  const challenge = parseChallenge(first.calls[0].options.headers['WWW-Authenticate']);
  assert.equal(challenge.realm, AUTH_REALM);
  assert.equal(challenge.algorithm, 'MD5');

  const validHeader = authorizationFor(challenge);
  const authenticated = challengeResponse();
  const admission = authenticator.authenticateInvite(request(validHeader), authenticated.response);
  assert.ok(admission);
  assert.equal(authenticated.calls.length, 0);
  assert.equal(authenticator.consumeAdmission(admission), true);
  assert.equal(authenticator.consumeAdmission(admission), false);

  const replay = challengeResponse();
  assert.equal(authenticator.authenticateInvite(request(validHeader), replay.response), null);
  assert.equal(replay.calls[0].status, 401);

  const wrongChallenge = parseChallenge(replay.calls[0].options.headers['WWW-Authenticate']);
  const wrong = challengeResponse();
  assert.equal(
    authenticator.authenticateInvite(
      request(authorizationFor(wrongChallenge, { password: CALLBACK_PASSWORD })),
      wrong.response
    ),
    null
  );
  assert.equal(wrong.calls[0].status, 401);
});

test('credential file metadata requires root ownership and the exact runtime group', () => {
  const regular = {
    uid: 0,
    gid: 4123,
    mode: 0o100440,
    nlink: 1,
    isFile: () => true,
  };
  assert.equal(hasSafeCredentialFileMetadata(regular, {
    effectiveUid: 4123,
    effectiveGid: 4123,
  }), true);
  assert.equal(hasSafeCredentialFileMetadata({ ...regular, uid: 4123 }, {
    effectiveUid: 4123,
    effectiveGid: 4123,
  }), false);
  assert.equal(hasSafeCredentialFileMetadata({ ...regular, gid: 5000 }, {
    effectiveUid: 4123,
    effectiveGid: 4123,
  }), false);
  assert.equal(hasSafeCredentialFileMetadata({ ...regular, mode: 0o100640 }, {
    effectiveUid: 4123,
    effectiveGid: 4123,
  }), false);
  assert.equal(hasSafeCredentialFileMetadata({ ...regular, nlink: 2 }, {
    effectiveUid: 4123,
    effectiveGid: 4123,
  }), false);
});

test('credential file loading rejects user-owned files, symlinks, and broad modes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sip-trunk-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secure = path.join(directory, 'secure');
  const broad = path.join(directory, 'broad');
  const linked = path.join(directory, 'linked');
  fs.writeFileSync(secure, `${INGRESS_PASSWORD}\n`, { mode: 0o400 });
  fs.writeFileSync(broad, CALLBACK_PASSWORD, { mode: 0o644 });
  fs.symlinkSync(secure, linked);

  assert.throws(() => readCredentialFile(secure, 'test credential'), /unsafe file metadata/);
  assert.throws(() => readCredentialFile(broad, 'test credential'), /unsafe file metadata/);
  assert.throws(() => readCredentialFile(linked, 'test credential'), /missing or unreadable/);
});
