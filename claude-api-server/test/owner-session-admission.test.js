'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertOwnerHostHeadroom } = require('../owner-session-admission');
const GiB = 1024 ** 3;
function fixture() {
  const values = { '/proc/meminfo': 'MemAvailable: 4194304 kB\n', '/proc/loadavg': '1.0 1.0 1.0 1/100 12',
    '/proc/pressure/memory': 'some avg10=0.00 avg60=0.00', '/proc/pressure/cpu': 'some avg10=5.00 avg60=5.00' };
  const pool = '/sys/fs/cgroup/user.slice/user-1000.slice';
  Object.assign(values, { [`${pool}/cpu.max`]: '500000 100000', [`${pool}/memory.max`]: String(11 * GiB),
    [`${pool}/memory.current`]: String(5 * GiB), [`${pool}/pids.max`]: '5000', [`${pool}/pids.current`]: '200' });
  return { values, pool, options: { read: (name) => values[name], statfs: () => ({ bavail: 1024 ** 2, bsize: 4096 }) } };
}

test('host admission uses accumulated owner memory, whole-host pressure and disk reserve', () => {
  const f = fixture();
  assert.deepEqual(assertOwnerHostHeadroom(f.options), { admitted: true });
  for (const [key, value, code] of [
    [`${f.pool}/memory.current`, String(10.5 * GiB), 'OWNER_HOST_RESOURCE_PRESSURE'],
    ['/proc/meminfo', 'MemAvailable: 1000000 kB\n', 'OWNER_HOST_RESOURCE_PRESSURE'],
    ['/proc/loadavg', '230.0 1.0 1.0 1/100 12', 'OWNER_HOST_RESOURCE_PRESSURE'],
    ['/proc/pressure/memory', 'some avg10=99.00 avg60=99.00', 'OWNER_HOST_RESOURCE_PRESSURE'],
    [`${f.pool}/memory.max`, String(20 * GiB), 'OWNER_HOST_POOL_UNBOUNDED'],
    [`${f.pool}/cpu.max`, 'max 100000', 'OWNER_HOST_RESOURCE_UNVERIFIED'],
  ]) {
    const old = f.values[key]; f.values[key] = value;
    assert.throws(() => assertOwnerHostHeadroom(f.options), { code }); f.values[key] = old;
  }
  assert.throws(() => assertOwnerHostHeadroom({ ...f.options, statfs: () => ({ bavail: 1, bsize: 4096 }) }),
    { code: 'OWNER_HOST_DISK_PRESSURE' });
});
