'use strict';

const HASH = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]{1,96}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9+][A-Za-z0-9_.:@/+%-]{0,255}$/u;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

class PbxApprovalAttesterStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PbxApprovalAttesterStoreError';
    this.code = code;
  }
}

function fail(message) {
  throw new PbxApprovalAttesterStoreError('PBX_ATTESTER_STORE_INVALID_ARGUMENT', message);
}

function schemaFail(message) {
  throw new PbxApprovalAttesterStoreError('PBX_ATTESTER_STORE_SCHEMA_INVALID', message);
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unsupported schema.`);
  }
  return value;
}

function string(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid.`);
  return value;
}

function normalizeClaim(record) {
  exactRecord(record, [
    'armSha256', 'armKeyId', 'approvalId', 'armNonce', 'pbxCallHandle',
    'expiresAt', 'claimedAt',
  ], 'PBX arm claim');
  const normalized = {
    armSha256: string(record.armSha256, HASH, 'armSha256'),
    armKeyId: string(record.armKeyId, KEY_ID, 'armKeyId'),
    approvalId: string(record.approvalId, ID, 'approvalId'),
    armNonce: string(record.armNonce, TOKEN, 'armNonce'),
    pbxCallHandle: string(record.pbxCallHandle, TOKEN, 'pbxCallHandle'),
    expiresAt: integer(record.expiresAt, 'expiresAt'),
    claimedAt: integer(record.claimedAt, 'claimedAt'),
  };
  if (normalized.expiresAt <= normalized.claimedAt) fail('The PBX arm is already expired.');
  return normalized;
}

function normalizeObservation(record) {
  exactRecord(record, [
    'armSha256', 'playbackId', 'dtmfEventId', 'callLegSha256', 'observedAt',
  ], 'PBX observation record');
  return {
    armSha256: string(record.armSha256, HASH, 'armSha256'),
    playbackId: string(record.playbackId, ID, 'playbackId'),
    dtmfEventId: string(record.dtmfEventId, ID, 'dtmfEventId'),
    callLegSha256: string(record.callLegSha256, HASH, 'callLegSha256'),
    observedAt: integer(record.observedAt, 'observedAt'),
  };
}

function normalizeFinal(record) {
  exactRecord(record, ['armSha256', 'evidenceSha256', 'issuedAt'], 'PBX evidence record');
  return {
    armSha256: string(record.armSha256, HASH, 'armSha256'),
    evidenceSha256: string(record.evidenceSha256, HASH, 'evidenceSha256'),
    issuedAt: integer(record.issuedAt, 'issuedAt'),
  };
}

function sqliteSchemaContract(tableName) {
  const indexName = `${tableName}_expires_idx`;
  const body = `(
      arm_sha256 TEXT PRIMARY KEY,
      arm_key_id TEXT NOT NULL,
      approval_id TEXT NOT NULL UNIQUE,
      arm_nonce TEXT NOT NULL UNIQUE,
      pbx_call_handle TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      playback_id TEXT UNIQUE,
      dtmf_event_id TEXT UNIQUE,
      call_leg_sha256 TEXT,
      observed_at INTEGER,
      evidence_sha256 TEXT UNIQUE,
      issued_at INTEGER,
      state TEXT NOT NULL CHECK (state IN ('pending', 'observed', 'issued'))
    )`;
  return Object.freeze({
    indexName,
    tableSql: `CREATE TABLE ${tableName} ${body}`,
    createTableSql: `CREATE TABLE main.${tableName} ${body}`,
    indexSql: `CREATE INDEX ${indexName} ON ${tableName}(expires_at)`,
    createIndexSql: `CREATE INDEX main.${indexName} ON ${tableName}(expires_at)`,
  });
}

function schemaRows(db, sql, values, label) {
  try {
    const statement = db.prepare(sql);
    if (!statement || typeof statement.all !== 'function') throw new Error('not a query');
    return statement.all(...values);
  } catch {
    schemaFail(`The SQLite ${label} could not be inspected safely.`);
  }
}

function schemaInteger(value) {
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : null;
}

function validateSqliteSchema(db, tableName, contract) {
  const tableRecords = schemaRows(
    db,
    'SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name = ?',
    [tableName],
    'PBX replay table',
  );
  const indexRecords = schemaRows(
    db,
    'SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name = ?',
    [contract.indexName],
    'PBX expiry index',
  );
  if (tableRecords.length !== 1 || tableRecords[0].type !== 'table' ||
      tableRecords[0].name !== tableName || tableRecords[0].tbl_name !== tableName ||
      tableRecords[0].sql !== contract.tableSql || indexRecords.length !== 1 ||
      indexRecords[0].type !== 'index' || indexRecords[0].name !== contract.indexName ||
      indexRecords[0].tbl_name !== tableName || indexRecords[0].sql !== contract.indexSql) {
    schemaFail('The SQLite PBX replay table or expiry index differs from the exact schema contract.');
  }

  const triggers = [
    ...schemaRows(
      db,
      "SELECT name FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = ?",
      [tableName],
      'PBX trigger closure',
    ),
    ...schemaRows(
      db,
      "SELECT name FROM temp.sqlite_schema WHERE type = 'trigger' AND tbl_name = ?",
      [tableName],
      'temporary PBX trigger closure',
    ),
  ];
  if (triggers.length !== 0) {
    schemaFail('The SQLite PBX replay table has an unreviewed trigger.');
  }

  const expectedColumns = [
    [0, 'arm_sha256', 'TEXT', 0, null, 1, 0],
    [1, 'arm_key_id', 'TEXT', 1, null, 0, 0],
    [2, 'approval_id', 'TEXT', 1, null, 0, 0],
    [3, 'arm_nonce', 'TEXT', 1, null, 0, 0],
    [4, 'pbx_call_handle', 'TEXT', 1, null, 0, 0],
    [5, 'expires_at', 'INTEGER', 1, null, 0, 0],
    [6, 'claimed_at', 'INTEGER', 1, null, 0, 0],
    [7, 'playback_id', 'TEXT', 0, null, 0, 0],
    [8, 'dtmf_event_id', 'TEXT', 0, null, 0, 0],
    [9, 'call_leg_sha256', 'TEXT', 0, null, 0, 0],
    [10, 'observed_at', 'INTEGER', 0, null, 0, 0],
    [11, 'evidence_sha256', 'TEXT', 0, null, 0, 0],
    [12, 'issued_at', 'INTEGER', 0, null, 0, 0],
    [13, 'state', 'TEXT', 1, null, 0, 0],
  ];
  const columns = schemaRows(
    db,
    'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?)',
    [tableName, 'main'],
    'PBX column schema',
  ).map((column) => [
    schemaInteger(column.cid), column.name, column.type, schemaInteger(column.notnull),
    column.dflt_value, schemaInteger(column.pk), schemaInteger(column.hidden),
  ]);
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    schemaFail('The SQLite PBX replay table has an unsafe column or primary-key layout.');
  }

  const expectedIndexes = new Map([
    ['arm_sha256', Object.freeze({ origin: 'pk', unique: 1 })],
    ['approval_id', Object.freeze({ origin: 'u', unique: 1 })],
    ['arm_nonce', Object.freeze({ origin: 'u', unique: 1 })],
    ['pbx_call_handle', Object.freeze({ origin: 'u', unique: 1 })],
    ['playback_id', Object.freeze({ origin: 'u', unique: 1 })],
    ['dtmf_event_id', Object.freeze({ origin: 'u', unique: 1 })],
    ['evidence_sha256', Object.freeze({ origin: 'u', unique: 1 })],
    ['expires_at', Object.freeze({ origin: 'c', unique: 0, name: contract.indexName })],
  ]);
  const indexes = schemaRows(
    db,
    'SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?, ?)',
    [tableName, 'main'],
    'PBX index closure',
  );
  if (indexes.length !== expectedIndexes.size) {
    schemaFail('The SQLite PBX replay table has an incomplete or additional index.');
  }
  const seenColumns = new Set();
  for (const index of indexes) {
    const details = schemaRows(
      db,
      'SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo(?, ?)',
      [index.name, 'main'],
      'PBX index definition',
    );
    const keyColumns = details.filter((entry) => schemaInteger(entry.key) === 1);
    const auxiliaries = details.filter((entry) => schemaInteger(entry.key) === 0);
    const key = keyColumns[0];
    const expected = key && expectedIndexes.get(key.name);
    if (schemaInteger(index.partial) !== 0 || keyColumns.length !== 1 ||
        auxiliaries.length !== 1 || schemaInteger(auxiliaries[0].cid) !== -1 ||
        auxiliaries[0].name !== null || schemaInteger(key.seqno) !== 0 ||
        schemaInteger(key.desc) !== 0 || key.coll !== 'BINARY' || !expected ||
        index.origin !== expected.origin || schemaInteger(index.unique) !== expected.unique ||
        (expected.name !== undefined && index.name !== expected.name) ||
        seenColumns.has(key.name)) {
      schemaFail('The SQLite PBX replay table has a weakened or ambiguous index.');
    }
    seenColumns.add(key.name);
  }
  if (seenColumns.size !== expectedIndexes.size) {
    schemaFail('The SQLite PBX replay table does not enforce every replay identity uniquely.');
  }
}

function initializeSqliteSchema(db, tableName) {
  const contract = sqliteSchemaContract(tableName);
  const existingTable = schemaRows(
    db,
    'SELECT type FROM main.sqlite_schema WHERE name = ?',
    [tableName],
    'PBX schema namespace',
  );
  if (existingTable.length === 0) {
    const existingIndex = schemaRows(
      db,
      'SELECT type FROM main.sqlite_schema WHERE name = ?',
      [contract.indexName],
      'PBX index namespace',
    );
    if (existingIndex.length !== 0) {
      schemaFail('The SQLite PBX expiry-index name is already occupied.');
    }
    const savepoint = `teleagent_pbx_schema_${tableName}`;
    try {
      db.exec(
        `SAVEPOINT ${savepoint};\n${contract.createTableSql};\n` +
        `${contract.createIndexSql};\nRELEASE ${savepoint};`,
      );
    } catch {
      try {
        db.exec(`ROLLBACK TO ${savepoint};\nRELEASE ${savepoint};`);
      } catch {
        // The original creation failure remains authoritative and fails closed.
      }
      schemaFail('The exact SQLite PBX replay schema could not be created atomically.');
    }
  }
  validateSqliteSchema(db, tableName, contract);
}

class MemoryPbxApprovalAttesterStore {
  constructor() {
    this.records = new Map();
  }

  claimArm(input) {
    const record = normalizeClaim(input);
    for (const existing of this.records.values()) {
      if (existing.armSha256 === record.armSha256 ||
          existing.approvalId === record.approvalId ||
          existing.armNonce === record.armNonce ||
          existing.pbxCallHandle === record.pbxCallHandle) return false;
    }
    this.records.set(record.armSha256, { ...record, status: 'pending' });
    return true;
  }

  recordObservation(input) {
    const observation = normalizeObservation(input);
    const record = this.records.get(observation.armSha256);
    if (!record || record.status !== 'pending') return false;
    for (const existing of this.records.values()) {
      if (existing.playbackId === observation.playbackId ||
          existing.dtmfEventId === observation.dtmfEventId) return false;
    }
    Object.assign(record, observation, { status: 'observed' });
    return true;
  }

  finalizeEvidence(input) {
    const evidence = normalizeFinal(input);
    const record = this.records.get(evidence.armSha256);
    if (!record || record.status !== 'observed') return false;
    for (const existing of this.records.values()) {
      if (existing.evidenceSha256 === evidence.evidenceSha256) return false;
    }
    Object.assign(record, evidence, { status: 'issued' });
    return true;
  }

  purgeExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
    integer(nowSeconds, 'nowSeconds');
    let removed = 0;
    for (const [armSha256, record] of this.records.entries()) {
      if (record.expiresAt <= nowSeconds) {
        this.records.delete(armSha256);
        removed += 1;
      }
    }
    return removed;
  }
}

function createSqlitePbxApprovalAttesterStore(db, {
  tableName = 'pbx_approval_attestations',
} = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function' ||
      !TABLE.test(tableName)) {
    fail('A compatible SQLite database and safe table name are required.');
  }
  initializeSqliteSchema(db, tableName);
  const claim = db.prepare(`
    INSERT OR IGNORE INTO main.${tableName} (
      arm_sha256, arm_key_id, approval_id, arm_nonce, pbx_call_handle,
      expires_at, claimed_at, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const observe = db.prepare(`
    UPDATE OR IGNORE main.${tableName}
    SET playback_id = ?, dtmf_event_id = ?, call_leg_sha256 = ?,
        observed_at = ?, state = 'observed'
    WHERE arm_sha256 = ? AND state = 'pending'
  `);
  const finalize = db.prepare(`
    UPDATE OR IGNORE main.${tableName}
    SET evidence_sha256 = ?, issued_at = ?, state = 'issued'
    WHERE arm_sha256 = ? AND state = 'observed'
  `);
  const purge = db.prepare(`DELETE FROM main.${tableName} WHERE expires_at <= ?`);

  return Object.freeze({
    claimArm(input) {
      const record = normalizeClaim(input);
      return claim.run(
        record.armSha256, record.armKeyId, record.approvalId, record.armNonce,
        record.pbxCallHandle, record.expiresAt, record.claimedAt,
      ).changes === 1;
    },
    recordObservation(input) {
      const record = normalizeObservation(input);
      return observe.run(
        record.playbackId, record.dtmfEventId, record.callLegSha256,
        record.observedAt, record.armSha256,
      ).changes === 1;
    },
    finalizeEvidence(input) {
      const record = normalizeFinal(input);
      return finalize.run(record.evidenceSha256, record.issuedAt, record.armSha256).changes === 1;
    },
    purgeExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
      integer(nowSeconds, 'nowSeconds');
      return purge.run(nowSeconds).changes;
    },
  });
}

module.exports = {
  MemoryPbxApprovalAttesterStore,
  PbxApprovalAttesterStoreError,
  createSqlitePbxApprovalAttesterStore,
};
