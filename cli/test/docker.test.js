import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { URL } from 'node:url';
import { generateDockerCompose, generateEnvFile } from '../lib/docker.js';
import voiceAppRuntimeEnv from '../../lib/voice-app-runtime-env.js';

const {
  VOICE_APP_FIXED_ENV,
  VOICE_APP_RUNTIME_ENV_KEYS
} = voiceAppRuntimeEnv;
const VOICE_IDENTITY = Object.freeze({
  name: 'teleagent-voice',
  uid: 989,
  gid: 989,
  home: '/var/lib/teleagent-voice',
  shell: '/usr/sbin/nologin',
});

function generateVoiceEnv(config) {
  return generateEnvFile(config, VOICE_IDENTITY);
}

function voiceAppEnvironmentEntries(compose) {
  const service = compose.match(
    /^  voice-app:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|(?![\s\S]))/m
  );
  assert.ok(service, 'generated Compose must define voice-app');
  const environment = service[1].match(
    /^    environment:\n([\s\S]*?)(?=^    [a-zA-Z0-9_-]+:|(?![\s\S]))/m
  );
  assert.ok(environment, 'generated voice-app must have an environment mapping');
  return {
    service: service[1],
    entries: new Map(
      [...environment[1].matchAll(/^      ([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/gm)]
        .map((entry) => [entry[1], entry[2]])
    )
  };
}

test('docker compose generation', async (t) => {
  await t.test('uses the fixed protected Drachtio configuration instead of inline SIP or secret flags', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      paths: {
        voiceApp: '/app/voice-app'
      },
      secrets: {
        drachtio: 'test-secret-123',
        freeswitch: 'test-secret-456'
      }
    };

    const compose = generateDockerCompose(config);

    assert.match(compose, /\/run\/teleagent-voice-stack\/drachtio\.conf\.xml:\/etc\/drachtio\.conf\.xml:ro/);
    assert.match(compose, /command: \["drachtio", "-f", "\/etc\/drachtio\.conf\.xml"\]/);
    assert.doesNotMatch(compose, /--(?:secret|contact|external-ip)\b/);
    assert.match(
      compose,
      /image: drachtio\/drachtio-server:latest@sha256:c03001e7c01ead29d0026245d0b42a9ebc8eefb0ff9bd180f5ff1f72be6da457/
    );
    assert.match(
      compose,
      /image: drachtio\/drachtio-freeswitch-mrf:latest@sha256:7a6ce26834ff1b8eb27e97f3b9db72980a511e83ef01897097ca92a0f2d5eb62/
    );
  });

  await t.test('pins the reviewed ARM64 image indexes in pi-split mode', () => {
    const compose = generateDockerCompose({
      server: { externalIp: '192.168.1.50' },
      paths: { voiceApp: '/app/voice-app' },
      secrets: { drachtio: 'test-secret-123', freeswitch: 'test-secret-456' },
      deployment: { mode: 'pi-split', pi: { drachtioPort: 5070 } }
    });

    assert.match(
      compose,
      /image: drachtio\/drachtio-server:0\.9\.4@sha256:09e99a715df06a1e90f9f3f9a4c89f4146026b3e7f6535a9939cdd5dc97538fe/
    );
    assert.ok(compose.includes('platform: linux/arm64'));
  });

  await t.test('does not interpolate a Pi SIP port into Drachtio argv', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      paths: {
        voiceApp: '/app/voice-app'
      },
      secrets: {
        drachtio: 'test-secret-123',
        freeswitch: 'test-secret-456'
      },
      deployment: {
        pi: {
          drachtioPort: 5070
        }
      }
    };

    const compose = generateDockerCompose(config);

    assert.doesNotMatch(compose, /--contact|:5070;transport/);
  });

  await t.test('does not interpolate the default SIP port into Drachtio argv', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      paths: {
        voiceApp: '/app/voice-app'
      },
      secrets: {
        drachtio: 'test-secret-123',
        freeswitch: 'test-secret-456'
      },
      deployment: {
        pi: {
          drachtioPort: 5060
        }
      }
    };

    const compose = generateDockerCompose(config);

    assert.doesNotMatch(compose, /--contact|:5060;transport/);
  });

  await t.test('preserves other compose settings when using custom port', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      paths: {
        voiceApp: '/app/voice-app'
      },
      secrets: {
        drachtio: 'test-secret-123',
        freeswitch: 'test-secret-456'
      },
      deployment: {
        pi: {
          drachtioPort: 5070
        }
      }
    };

    const compose = generateDockerCompose(config);

    // Verify other settings remain intact
    assert.ok(compose.includes('network_mode: host'), 'Should use host networking');
    assert.ok(compose.includes('--sip-port 5080'), 'FreeSWITCH should use port 5080');
    assert.ok(compose.includes('/etc/drachtio.conf.xml'), 'Drachtio should use fixed config');
    assert.ok(!compose.includes('192.168.1.50'), 'Host configuration cannot redirect SIP/media');
  });

  await t.test('refuses retired Pi split-host controller routing', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      sip: {
        domain: '3cx.local',
        registrar: '192.168.1.10'
      },
      devices: [
        {
          extension: '9000',
          authId: 'user123',
          password: 'pass123',
          voiceId: 'voice-id'
        }
      ],
      api: {
        tts: { baseUrl: 'http://127.0.0.1:18000/v1', apiKey: 'not-needed', model: 'kokoro', defaultVoice: 'af_bella' },
        stt: { baseUrl: 'http://127.0.0.1:18001/v1', apiKey: 'not-needed', model: 'whisper-1' }
      },
      secrets: {
        drachtio: 'drachtio-secret',
        freeswitch: 'fs-secret'
      },
      deployment: {
        mode: 'pi-split',
        pi: {
          macIp: '192.168.1.100'
        }
      }
    };

    assert.throws(
      () => generateVoiceEnv(config),
      /Split-host voice\/controller deployment is retired/
    );
  });

  await t.test('generates env file with localhost for standard mode', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      sip: {
        domain: '3cx.local',
        registrar: '192.168.1.10'
      },
      devices: [
        {
          extension: '9000',
          authId: 'user123',
          password: 'pass123',
          voiceId: 'voice-id'
        }
      ],
      api: {
        tts: { baseUrl: 'http://127.0.0.1:18000/v1', apiKey: 'not-needed', model: 'kokoro', defaultVoice: 'af_bella' },
        stt: { baseUrl: 'http://127.0.0.1:18001/v1', apiKey: 'not-needed', model: 'whisper-1' }
      },
      secrets: {
        drachtio: 'drachtio-secret',
        freeswitch: 'fs-secret'
      },
      deployment: {
        mode: 'standard'
      }
    };

    const envFile = generateVoiceEnv(config);

    // Should use localhost for standard mode
    assert.ok(envFile.includes('AGENT_API_URL=http://127.0.0.1:3333'));
    assert.ok(!envFile.includes('CLAUDE_API_URL='), 'Retired controller aliases stay absent');
    assert.ok(!envFile.includes('TTS_BASE_URL='));
    assert.ok(!envFile.includes('STT_BASE_URL='));
    assert.ok(!envFile.includes('OPENAI_REALTIME_API_KEY='));
    assert.ok(envFile.includes('OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini'));
    assert.ok(!envFile.includes('DRACHTIO_SIP_TRANSPORT='));
    assert.ok(envFile.includes('OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS=240'));
    assert.ok(envFile.includes('OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT=16000'));
    assert.ok(envFile.includes('VOICE_STATE_DB_PATH=/app/state/voice-state.sqlite'));
    assert.ok(!envFile.includes('SIP_AUTH_ID='));
    assert.ok(!envFile.includes('SIP_AUTH_PASSWORD='));
  });

  await t.test('generates env file with localhost for both mode (all-in-one)', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      sip: {
        domain: '3cx.local',
        registrar: '192.168.1.10'
      },
      devices: [
        {
          extension: '9000',
          authId: 'user123',
          password: 'pass123',
          voiceId: 'voice-id'
        }
      ],
      api: {
        tts: { baseUrl: 'http://127.0.0.1:18000/v1', apiKey: 'not-needed', model: 'kokoro', defaultVoice: 'af_bella' },
        stt: { baseUrl: 'http://127.0.0.1:18001/v1', apiKey: 'not-needed', model: 'whisper-1' }
      },
      secrets: {
        drachtio: 'drachtio-secret',
        freeswitch: 'fs-secret'
      },
      deployment: {
        mode: 'both'
      }
    };

    const envFile = generateVoiceEnv(config);

    // Should use localhost for both mode (all services on same machine)
    assert.ok(envFile.includes('AGENT_API_URL=http://127.0.0.1:3333'),
      'Should use loopback for both mode (all-in-one installation)');
    assert.ok(!envFile.includes('CLAUDE_API_URL='));

    // Should NOT use any remote IP
    assert.ok(!envFile.includes('AGENT_API_URL=http://192.168.'),
      'Should not use remote IP for both mode');
  });

  await t.test('refuses retired voice-server remote controller routing', () => {
    const config = {
      server: {
        externalIp: '192.168.1.50',
        httpPort: 3000,
        claudeApiPort: 3333
      },
      sip: {
        domain: '3cx.local',
        registrar: '192.168.1.10'
      },
      devices: [
        {
          extension: '9000',
          authId: 'user123',
          password: 'pass123',
          voiceId: 'voice-id'
        }
      ],
      api: {
        tts: { baseUrl: 'http://127.0.0.1:18000/v1', apiKey: 'not-needed', model: 'kokoro', defaultVoice: 'af_bella' },
        stt: { baseUrl: 'http://127.0.0.1:18001/v1', apiKey: 'not-needed', model: 'whisper-1' }
      },
      secrets: {
        drachtio: 'drachtio-secret',
        freeswitch: 'fs-secret'
      },
      deployment: {
        mode: 'voice-server',
        apiServerIp: '192.168.1.200'
      }
    };

    assert.throws(
      () => generateVoiceEnv(config),
      /Split-host voice\/controller deployment is retired/
    );
  });

  await t.test('generates Codex profile settings and independent workspaces', () => {
    const config = {
      server: { externalIp: '192.168.1.50', httpPort: 3000, claudeApiPort: 3333 },
      sip: { domain: '3cx.local', registrar: '192.168.1.10' },
      devices: [{ extension: '9000', authId: 'user123', password: 'pass123', voiceId: 'alb' }],
      api: { tts: {}, stt: {} },
      secrets: { drachtio: 'drachtio-secret', freeswitch: 'fs-secret' },
      agents: {
        providers: ['codex'],
        codex: {
          command: 'codex',
          workingDirectory: '/srv/read',
          approvalPolicy: 'never',
          luna: { model: 'gpt-5.6-luna', reasoningEffort: 'low', sandbox: 'read-only', workingDirectory: '/srv/read' },
          terra: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', sandbox: 'workspace-write', workingDirectory: '/srv/phone' },
          sol: { model: 'gpt-5.6-sol', reasoningEffort: 'high', sandbox: 'danger-full-access', workingDirectory: '/srv/admin' }
        }
      }
    };

    const envFile = generateVoiceEnv(config);
    assert.ok(envFile.includes('AGENT_PROVIDERS=codex'));
    assert.ok(envFile.includes('PHONE_CODEX_LUNA_WORKING_DIR=/srv/read'));
    assert.ok(envFile.includes('PHONE_CODEX_TERRA_WORKING_DIR=/srv/phone'));
    assert.ok(envFile.includes('PHONE_CODEX_SOL_WORKING_DIR=/srv/admin'));
  });

  await t.test('generates enabled Realtime settings and a durable state mount', () => {
    const config = {
      server: { externalIp: '192.168.1.50', httpPort: 3000, claudeApiPort: 3333 },
      sip: { domain: '3cx.local', registrar: '192.168.1.10' },
      devices: [{ extension: '9000', authId: 'user123', password: 'pass123', voiceId: 'alb' }],
      paths: { voiceApp: '/srv/teleagent/voice-app' },
      api: {
        tts: {},
        stt: {},
        realtime: {
          enabled: true,
          apiKey: 'test-openai-key',
          model: 'gpt-realtime-2.1-mini',
          voice: 'marin',
          transcriptionModel: 'gpt-live-transcribe',
          safetyIdentifierSalt: 'test-salt'
        }
      },
      secrets: { drachtio: 'drachtio-secret', freeswitch: 'fs-secret' }
    };

    const envFile = generateVoiceEnv(config);
    const compose = generateDockerCompose(config);
    assert.ok(!envFile.includes('test-openai-key'));
    assert.ok(envFile.includes('OPENAI_REALTIME_VOICE=marin'));
    assert.ok(!envFile.includes('test-salt'));
    assert.ok(compose.includes('${VOICE_STATE_DIR:?VOICE_STATE_DIR must be provisioned}:/app/state'));
  });

  await t.test('matches the hardened repository build and runtime boundary', () => {
    const config = {
      server: { externalIp: '192.168.1.50', httpPort: 3000, claudeApiPort: 3333 },
      sip: { domain: '3cx.local', registrar: '192.168.1.10' },
      devices: [],
      paths: { voiceApp: '/srv/teleagent/voice-app' },
      api: { tts: {}, stt: {} },
      secrets: { drachtio: 'drachtio-secret', freeswitch: 'fs-secret' }
    };

    const compose = generateDockerCompose(config);
    const envFile = generateVoiceEnv(config);
    const generatedAgain = generateVoiceEnv(config);
    const voiceEnvironment = voiceAppEnvironmentEntries(compose);
    const env = Object.fromEntries(envFile.split('\n').filter((line) => (
      line && !line.startsWith('#') && line.includes('=')
    )).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));

    assert.equal((compose.match(/image: "\$\{TELEAGENT_VOICE_IMAGE:\?/g) || []).length, 2);
    assert.doesNotMatch(compose, /^\s+build:/m);
    assert.doesNotMatch(compose, /^\s+(?:context|dockerfile):/m);
    assert.match(compose, /entrypoint-hermes-freeswitch\.sh:ro/);
    assert.match(
      compose,
      /user: "\$\{VOICE_APP_UID:\?VOICE_APP_UID must resolve teleagent-voice}:\$\{VOICE_APP_GID:\?VOICE_APP_GID must resolve teleagent-voice}"/
    );
    assert.doesNotMatch(compose, /VOICE_APP_(?:UID|GID):-/);
    assert.doesNotMatch(compose, /(?:uid|gid)=1000|user: "1000:1000"/);
    assert.match(compose, /read_only: true/);
    assert.match(
      compose,
      /\/tmp:rw,noexec,nosuid,nodev,uid=\$\{VOICE_APP_UID:\?[^}]+},gid=\$\{VOICE_APP_GID:\?[^}]+},mode=0700,size=536870912/
    );
    assert.doesNotMatch(compose, /voice-app\/audio:\/app\/audio/);
    assert.doesNotMatch(compose, /voice-app\/static:\/app\/static/);
    assert.match(compose, /AGENT_API_TOKEN: ""/);
    assert.match(compose, /CLAUDE_API_TOKEN: ""/);
    assert.match(compose, /\/run\/teleagent-voice-stack\/voice-secrets:\/run\/secrets:ro/);
    assert.doesNotMatch(voiceEnvironment.service, /^    env_file:/m);
    assert.deepEqual(
      [...voiceEnvironment.entries.keys()].sort(),
      [...Object.keys(VOICE_APP_FIXED_ENV), ...VOICE_APP_RUNTIME_ENV_KEYS].sort()
    );
    for (const [key, value] of Object.entries(VOICE_APP_FIXED_ENV)) {
      assert.equal(voiceEnvironment.entries.get(key), JSON.stringify(value));
    }
    for (const key of VOICE_APP_RUNTIME_ENV_KEYS) {
      assert.equal(voiceEnvironment.entries.get(key), `"\${${key}:-}"`);
    }
    assert.ok(!voiceEnvironment.entries.has('VOICE_APPROVAL_SIGNING_KEY_HOST_FILE'));
    assert.ok(!voiceEnvironment.entries.has('VOICE_APPROVAL_PUBLIC_KEY_FILE'));
    assert.ok(!voiceEnvironment.entries.has('EXECUTOR_TASK_DB_PATH'));
    assert.ok(!voiceEnvironment.entries.has('AGENT_WORKER_HOME'));
    assert.ok(!voiceEnvironment.entries.has('CODEX_COMMAND'));
    assert.ok(!voiceEnvironment.entries.has('CLAUDE_COMMAND'));
    assert.equal((compose.match(/cap_drop:/g) || []).length, 4);
    assert.doesNotMatch(compose, /media-control-preflight:/);
    assert.match(compose, /voice-runtime-preflight:[\s\S]*network_mode: none/);
    assert.match(
      compose,
      /voice-runtime-preflight:[\s\S]*command: \["node", "voice-runtime-preflight\.js"\]/
    );
    assert.doesNotMatch(compose, /(?:DRACHTIO_SECRET|FREESWITCH_SECRET|EXECUTOR_API_TOKEN|VOICE_CONTROL_TOKEN|PRIVILEGED_ACTION_API_TOKEN|OUTBOUND_API_TOKEN):/);
    assert.doesNotMatch(compose, /--(?:secret|password)\b/);
    assert.equal((compose.match(/core: 0/g) || []).length, 3);
    assert.equal((compose.match(/restart: "no"/g) || []).length, 4);
    assert.doesNotMatch(compose, /sip:\*:/);

    assert.match(env.AGENT_API_TOKEN, /^[a-f0-9]{64}$/);
    for (const name of [
      'DRACHTIO_SECRET', 'FREESWITCH_SECRET', 'EXECUTOR_API_TOKEN',
      'VOICE_CONTROL_TOKEN', 'PRIVILEGED_ACTION_API_TOKEN', 'OUTBOUND_API_TOKEN',
      'OPENAI_REALTIME_API_KEY', 'OPENAI_SAFETY_IDENTIFIER_SALT', 'STT_API_KEY', 'TTS_API_KEY',
    ]) assert.equal(env[name], undefined, `${name} must not be written to the env file`);
    assert.equal(env.HTTP_HOST, '127.0.0.1');
    assert.equal(env.WS_HOST, '127.0.0.1');
    assert.equal(env.WS_CONNECT_HOST, '127.0.0.1');
    assert.equal(env.WS_NON_LOOPBACK_ENABLED, 'false');
    assert.equal(env.OUTBOUND_API_NON_LOOPBACK_ENABLED, 'false');
    assert.equal(env.SIP_TRUNK_HOST, undefined);
    assert.equal(env.SIP_TRUNK_PORT, undefined);
    assert.equal(env.SIP_TRUNK_TRANSPORT, undefined);
    assert.equal(env.VOICE_APP_UID, '989');
    assert.equal(env.VOICE_APP_GID, '989');
    assert.equal(env.DEVICE_CONFIG_DIR, '/etc/teleagent-voice/config');
    assert.equal(env.VOICE_STATE_DIR, '/var/lib/teleagent-voice');
    assert.equal(env.VOICE_APPROVAL_SIGNING_KEY_HOST_FILE, undefined);
    assert.equal(env.SIP_TRUNK_INGRESS_PASSWORD_HOST_FILE, undefined);
    assert.equal(env.SIP_TRUNK_CALLBACK_PASSWORD_HOST_FILE, undefined);
    assert.equal(env.VOICE_APPROVAL_CAPABILITY_ENABLED, 'false');
    assert.equal(env.AUDIO_DIR, undefined);
    assert.equal(generatedAgain, envFile, 'regeneration must not rotate persisted config secrets');
  });

  await t.test('routes normal voice start and stop through the guarded systemd unit', () => {
    const source = fs.readFileSync(new URL('../lib/docker.js', import.meta.url), 'utf8');
    const management = source.slice(source.indexOf('export async function startContainers'),
      source.indexOf('/**\n * Get status of Docker containers'));
    assert.match(management, /manageVoiceStackUnit\('start'\)/);
    assert.match(management, /manageVoiceStackUnit\('stop'\)/);
    assert.match(management,
      /spawn\(VOICE_STACK_SYSTEMCTL, \[action, VOICE_STACK_UNIT\]/);
    assert.doesNotMatch(management, /composeArgs|\bcompose\.cmd\b|'-d'/);
  });
});
