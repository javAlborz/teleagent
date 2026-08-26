import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getConfigPath,
  getConfigDir,
  loadConfig,
  loadConfigReadOnly,
  loadConfigWithVoiceRuntimeIdentityPreflight,
  peekConfig,
  saveConfig,
  configExists
} from '../lib/config.js';

// Test config directory
const TEST_HOME = path.join(os.tmpdir(), 'claude-phone-test-' + Date.now());
process.env.HOME = TEST_HOME;

test('config module', async (t) => {
  await t.test('getConfigDir returns ~/.claude-phone', () => {
    const dir = getConfigDir();
    assert.strictEqual(dir, path.join(TEST_HOME, '.claude-phone'));
  });

  await t.test('getConfigPath returns ~/.claude-phone/config.json', () => {
    const configPath = getConfigPath();
    assert.strictEqual(configPath, path.join(TEST_HOME, '.claude-phone', 'config.json'));
  });

  await t.test('configExists returns false when no config', () => {
    assert.strictEqual(configExists(), false);
  });

  await t.test('saveConfig creates directory and writes config', async () => {
    const config = {
      version: '1.0.0',
      api: {
        elevenlabs: { apiKey: 'test-key-123', defaultVoiceId: 'legacy-voice', validated: true },
        openai: { apiKey: 'legacy-openai-key', validated: false }
      },
      secrets: {
        drachtio: 'retired-drachtio-secret',
        freeswitch: 'retired-freeswitch-secret',
      },
    };

    await saveConfig(config);

    const configPath = getConfigPath();
    assert.strictEqual(fs.existsSync(configPath), true);

    const stats = fs.statSync(configPath);
    // Check permissions are 0600 (owner read/write only)
    assert.strictEqual((stats.mode & 0o777).toString(8), '600');
  });

  await t.test('peekConfig neither migrates nor writes the configuration', async () => {
    const configPath = getConfigPath();
    const backupPath = `${configPath}.backup`;
    const before = await fs.promises.readFile(configPath, 'utf8');
    const snapshot = await peekConfig();

    assert.strictEqual(snapshot.installationType, undefined);
    assert.strictEqual(snapshot.api.elevenlabs.defaultVoiceId, 'legacy-voice');
    assert.strictEqual(snapshot.secrets.drachtio, 'retired-drachtio-secret');
    assert.strictEqual(snapshot.secrets.freeswitch, 'retired-freeswitch-secret');
    assert.strictEqual(await fs.promises.readFile(configPath, 'utf8'), before);
    assert.strictEqual(fs.existsSync(backupPath), false);
  });

  await t.test('read-only loading returns a migrated view without changing input or disk', async () => {
    const configPath = getConfigPath();
    const backupPath = `${configPath}.backup`;
    const before = await fs.promises.readFile(configPath, 'utf8');
    const snapshot = await peekConfig();
    const snapshotBefore = JSON.stringify(snapshot);
    const config = await loadConfigReadOnly({ snapshot });

    assert.strictEqual(config.installationType, 'both');
    assert.strictEqual(config.api.tts.defaultVoice, 'legacy-voice');
    assert.strictEqual(config.secrets.drachtio, undefined);
    assert.strictEqual(config.secrets.freeswitch, undefined);
    assert.strictEqual(JSON.stringify(snapshot), snapshotBefore);
    assert.strictEqual(await fs.promises.readFile(configPath, 'utf8'), before);
    assert.strictEqual(fs.existsSync(backupPath), false);
  });

  await t.test('identity refusal occurs before persistent loading can change bytes', async () => {
    const configPath = getConfigPath();
    const before = await fs.promises.readFile(configPath, 'utf8');
    let identityCalls = 0;

    await assert.rejects(
      loadConfigWithVoiceRuntimeIdentityPreflight({
        identityResolver(installationType) {
          identityCalls += 1;
          assert.strictEqual(installationType, 'both');
          throw new Error('fixture voice identity refusal');
        },
      }),
      /fixture voice identity refusal/,
    );

    assert.strictEqual(identityCalls, 1);
    assert.strictEqual(await fs.promises.readFile(configPath, 'utf8'), before);
    assert.strictEqual(fs.existsSync(`${configPath}.backup`), false);
  });

  await t.test('loadConfig reads saved config', async () => {
    const config = await loadConfig();
    assert.strictEqual(config.version, '1.0.0');
    assert.strictEqual(config.api.tts.apiKey, undefined);
    assert.strictEqual(config.api.tts.defaultVoice, 'legacy-voice');
    assert.strictEqual(config.api.stt, undefined);
    assert.strictEqual(config.api.openai, undefined);
    assert.strictEqual(config.secrets.drachtio, undefined);
    assert.strictEqual(config.secrets.freeswitch, undefined);
    assert.strictEqual(config.api.realtime.enabled, false);
    assert.strictEqual(config.api.realtime.model, 'gpt-realtime-2.1-mini');
    assert.deepStrictEqual(config.agents.providers, ['claude']);
    assert.strictEqual(config.agents.codex.luna.model, 'gpt-5.6-luna');
  });

  await t.test('configExists returns true after save', () => {
    assert.strictEqual(configExists(), true);
  });

  await t.test('saveConfig updates existing config', async () => {
    const updated = {
      version: '1.0.0',
      api: {
        tts: {
          baseUrl: 'http://127.0.0.1:18080/v1',
          apiKey: 'not-needed',
          model: 'kokoro',
          defaultVoice: 'af_sky',
          validated: true
        },
        stt: {
          baseUrl: 'http://127.0.0.1:18001/v1',
          apiKey: 'not-needed',
          model: 'whisper-1',
          validated: false
        }
      }
    };

    await saveConfig(updated);
    const config = await loadConfig();
    assert.strictEqual(config.api.tts.baseUrl, undefined);
    assert.strictEqual(config.api.tts.apiKey, undefined);
    assert.strictEqual(config.api.tts.defaultVoice, 'af_sky');
    assert.strictEqual(config.api.stt, undefined);
  });

  await t.test('config with deployment.mode defaults to standard', async () => {
    const config = {
      version: '1.1.0',
      deployment: {
        mode: 'standard',
        platform: 'darwin'
      },
      api: {}
    };

    await saveConfig(config);
    const loaded = await loadConfig();
    assert.strictEqual(loaded.deployment.mode, 'standard');
    assert.strictEqual(loaded.deployment.platform, 'darwin');
  });

  await t.test('config with pi-split mode includes pi section', async () => {
    const config = {
      version: '1.1.0',
      deployment: {
        mode: 'pi-split',
        platform: 'linux-arm64',
        piDetected: true,
        pi: {
          sbcDetected: true,
          drachtioPort: 5070,
          macApiUrl: 'http://192.168.1.100:3333'
        }
      },
      api: {}
    };

    await saveConfig(config);
    const loaded = await loadConfig();
    assert.strictEqual(loaded.deployment.mode, 'pi-split');
    assert.strictEqual(loaded.deployment.pi.drachtioPort, 5070);
    assert.strictEqual(loaded.deployment.pi.macApiUrl, 'http://192.168.1.100:3333');
  });

  await t.test('config version 1.1.0 includes deployment field', async () => {
    const config = {
      version: '1.1.0',
      deployment: {
        mode: 'standard',
        platform: 'darwin'
      }
    };

    await saveConfig(config);
    const loaded = await loadConfig();
    assert.strictEqual(loaded.version, '1.1.0');
    assert.ok('deployment' in loaded, 'Should have deployment field');
  });

  // Cleanup
  t.after(() => {
    if (fs.existsSync(TEST_HOME)) {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });
});
