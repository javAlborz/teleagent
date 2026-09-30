'use strict';

const fs = require('node:fs');
const { sessionError } = require('./owner-session-endpoint');
const GiB = 1024 ** 3;
const OWNER_POOL = '/sys/fs/cgroup/user.slice/user-1000.slice';

function numeric(text) {
  if (!/^\d+$/.test(text.trim())) throw sessionError('OWNER_HOST_RESOURCE_UNVERIFIED');
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value)) throw sessionError('OWNER_HOST_RESOURCE_UNVERIFIED');
  return value;
}
function pressure(text) {
  const match = /^some avg10=(\d+(?:\.\d+)?) /m.exec(text);
  if (!match) throw sessionError('OWNER_HOST_RESOURCE_UNVERIFIED');
  return Number(match[1]);
}

// This does not impose a daily/model allowance. It checks whole-host pressure,
// disk reserve and the existing aggregate owner pool before admitting new work.
// Existing personal agents keep their own permissions/account and lifetime.
function assertOwnerHostHeadroom({ read = (name) => fs.readFileSync(name, 'utf8'),
  statfs = (name) => fs.statfsSync(name) } = {}) {
  const mem = /^MemAvailable:\s+(\d+) kB$/m.exec(read('/proc/meminfo'));
  const loadText = read('/proc/loadavg').trim().split(/\s+/)[0];
  if (!mem || !/^\d+(?:\.\d+)?$/.test(loadText)) throw sessionError('OWNER_HOST_RESOURCE_UNVERIFIED');
  const available = Number(mem[1]) * 1024;
  const load = Number(loadText);
  const cpu = read(`${OWNER_POOL}/cpu.max`).trim().split(/\s+/);
  const memoryMax = numeric(read(`${OWNER_POOL}/memory.max`));
  const memoryCurrent = numeric(read(`${OWNER_POOL}/memory.current`));
  const tasksMax = numeric(read(`${OWNER_POOL}/pids.max`));
  const tasksCurrent = numeric(read(`${OWNER_POOL}/pids.current`));
  if (cpu.length !== 2 || numeric(cpu[1]) < 1 || numeric(cpu[0]) / numeric(cpu[1]) > 5 ||
      memoryMax > 11 * GiB || memoryMax < GiB || tasksMax > 5000 || tasksMax < 1) {
    throw sessionError('OWNER_HOST_POOL_UNBOUNDED');
  }
  for (const root of ['/', '/srv/hermes-state']) {
    const space = statfs(root);
    if (!Number.isSafeInteger(space.bavail) || !Number.isSafeInteger(space.bsize) ||
        space.bavail * space.bsize < 2 * GiB) throw sessionError('OWNER_HOST_DISK_PRESSURE');
  }
  if (available < 2 * GiB || load > 8 || pressure(read('/proc/pressure/memory')) > 1 ||
      pressure(read('/proc/pressure/cpu')) > 50 || memoryMax - memoryCurrent < GiB ||
      tasksMax - tasksCurrent < 128) throw sessionError('OWNER_HOST_RESOURCE_PRESSURE');
  return { admitted: true };
}

function assertOwnerProcessPool(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw sessionError('OWNER_HOST_RESOURCE_UNVERIFIED');
  const membership = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
  if (!/^0::\/user\.slice\/user-1000\.slice\//.test(membership) || membership.includes('\n')) {
    throw sessionError('OWNER_SESSION_OUTSIDE_OWNER_POOL');
  }
}
module.exports = { assertOwnerHostHeadroom, assertOwnerProcessPool };
