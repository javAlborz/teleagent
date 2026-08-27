'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeArgs,
  buildCodexArgs,
  buildCodexEnvironment,
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
  normalizeCodexSandbox,
  parseAgentStdout,
  parseClaudeStdout,
  parseCodexStdout,
} = require('../agent-cli');

test('buildClaudeArgs always selects bare safe mode and root-owned empty configuration', () => {
  assert.deepEqual(buildClaudeArgs({
    model: 'claude-sonnet-5',
    permissionMode: 'dontAsk',
    tools: ['Read', 'Glob', 'Grep'],
    allowedTools: ['Read', 'Glob', 'Grep'],
  }), [
    '-p', '--bare', '--safe-mode', '--strict-mcp-config',
    '--mcp-config', '/etc/teleagent/provider-runtime/empty-mcp.json',
    '--settings', '/etc/teleagent/provider-runtime/empty-settings.json',
    '--model', 'claude-sonnet-5', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
  ]);
  assert.throws(() => buildClaudeArgs({
    model: 'claude-sonnet-5', permissionMode: 'dontAsk', sessionId: 'legacy-session',
  }), /Persistent Claude provider sessions are disabled/);
});

test('buildCodexEnvironment strips controller, provider API, and transport secrets', () => {
  const environment = buildCodexEnvironment({
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    OPENAI_API_KEY: 'provider-api-secret',
    OPENAI_REALTIME_API_KEY: 'voice-secret',
    OPENAI_SAFETY_IDENTIFIER_SALT: 'voice-salt',
    CLAUDE_API_TOKEN: 'bridge-secret',
    AGENT_API_TOKEN: 'neutral-bridge-secret',
    OUTBOUND_API_TOKEN: 'outbound-secret',
    DRACHTIO_SECRET: 'drachtio-secret',
    FREESWITCH_SECRET: 'freeswitch-secret',
    SIP_AUTH_PASSWORD: 'sip-secret',
    TTS_API_KEY: 'tts-secret',
    STT_API_KEY: 'stt-secret',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh',
    KUBECONFIG: '/run/secrets/kubeconfig',
    CLOUDFLARE_API_TOKEN: 'cloud-secret',
    CUSTOM_PASSWORD: 'custom-secret',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
  });
});

test('buildCodexArgs creates a bounded non-interactive invocation', () => {
  assert.deepEqual(
    buildCodexArgs({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      workingDirectory: '/home/alborz',
    }),
    [
      '--ask-for-approval', 'never',
      '--sandbox', 'read-only',
      '--model', 'gpt-5.6-luna',
      '--config', 'model_reasoning_effort="low"',
      '--cd', '/home/alborz',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--skip-git-repo-check',
      '--json',
      '-',
    ]
  );
});

test('buildCodexArgs rejects stored Codex threads instead of exposing shared provider state', () => {
  assert.throws(() => buildCodexArgs({
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    workingDirectory: '/home/alborz',
    sessionId: '019ff711-d480-7f22-8fd4-01acf85cb83d',
  }), /Persistent Codex provider sessions are disabled/);
});

test('read-only Codex launches disable provider-side search and ignore persistent configuration', () => {
  const args = buildCodexArgs({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    workingDirectory: '/home/alborz',
  });

  assert.equal(args.includes('--search'), false);
  assert.equal(args.indexOf('--ignore-user-config') > args.indexOf('exec'), true);
  assert.equal(args.includes('resume'), false);
});

test('Codex policy values fall back safely', () => {
  assert.equal(normalizeCodexSandbox('invalid'), 'read-only');
  assert.equal(normalizeCodexApprovalPolicy('invalid'), 'never');
  assert.equal(normalizeCodexReasoningEffort('invalid'), 'medium');
});

test('parseCodexStdout discards provider thread identity and keeps the final agent message', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'ignored' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
  ].join('\n');

  assert.deepEqual(parseCodexStdout(stdout), {
    response: 'final',
    error: null,
    providerContextPersistent: false,
  });
});

test('parseCodexStdout preserves structured failure details', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-456' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'model unavailable' } }),
  ].join('\n');

  assert.deepEqual(parseCodexStdout(stdout), {
    response: '',
    error: 'model unavailable',
    providerContextPersistent: false,
  });
});

test('parseClaudeStdout discards provider session identity from the Claude JSONL contract', () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: 'Claude result',
    session_id: 'claude-session',
  });

  assert.deepEqual(parseClaudeStdout(stdout), {
    response: 'Claude result',
    providerContextPersistent: false,
  });
  assert.deepEqual(parseAgentStdout('claude', stdout), parseClaudeStdout(stdout));
});
