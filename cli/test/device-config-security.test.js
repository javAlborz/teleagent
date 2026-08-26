import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDeviceConfiguration } from '../lib/commands/start.js';

test('device configuration atomically writes persona metadata and rejects legacy authentication', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teleagent-device-config-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'config');
  await fs.promises.mkdir(configDirectory, { recursive: true });
  const target = path.join(configDirectory, 'devices.json');
  await fs.promises.writeFile(target, '{}', { mode: 0o644 });

  const persona = {
    name: 'Owner',
    extension: '7',
    sessionType: 'phone-sonnet',
    prompt: 'Act as the private owner assistant.',
  };
  await writeDeviceConfiguration({
    paths: { voiceApp: root },
    devices: [persona]
  });

  assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o600);
  const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'));
  assert.deepEqual(parsed['7'], persona);
  const accepted = await fs.promises.readFile(target, 'utf8');
  await assert.rejects(writeDeviceConfiguration({
    paths: { voiceApp: root },
    devices: [{ ...persona, password: 'private-sip-password' }],
  }), /persona\/routing metadata only/);
  assert.equal(await fs.promises.readFile(target, 'utf8'), accepted);
  assert.deepEqual(
    (await fs.promises.readdir(configDirectory)).filter((name) => name.includes('.tmp-')),
    []
  );
});
