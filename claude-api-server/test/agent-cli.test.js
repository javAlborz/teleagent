'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCodexArgs,
  normalizeCodexApprovalPolicy,
  normalizeCodexReasoningEffort,
  normalizeCodexSandbox,
  parseAgentStdout,
  parseClaudeStdout,
  parseCodexStdout,
} = require('../agent-cli');

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
      '--skip-git-repo-check',
      '--json',
      '-',
    ]
  );
});

test('buildCodexArgs resumes the exact stored Codex thread', () => {
  const args = buildCodexArgs({
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    workingDirectory: '/home/alborz',
    sessionId: '019ff711-d480-7f22-8fd4-01acf85cb83d',
  });

  assert.deepEqual(args.slice(-6), [
    'exec',
    'resume',
    '--skip-git-repo-check',
    '--json',
    '019ff711-d480-7f22-8fd4-01acf85cb83d',
    '-',
  ]);
  assert.equal(args.includes('--ephemeral'), false);
});

test('Codex policy values fall back safely', () => {
  assert.equal(normalizeCodexSandbox('invalid'), 'read-only');
  assert.equal(normalizeCodexApprovalPolicy('invalid'), 'never');
  assert.equal(normalizeCodexReasoningEffort('invalid'), 'medium');
});

test('parseCodexStdout extracts the thread and final agent message', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'ignored' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
  ].join('\n');

  assert.deepEqual(parseCodexStdout(stdout), {
    response: 'final',
    sessionId: 'thread-123',
    error: null,
  });
});

test('parseCodexStdout preserves structured failure details', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-456' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'model unavailable' } }),
  ].join('\n');

  assert.deepEqual(parseCodexStdout(stdout), {
    response: '',
    sessionId: 'thread-456',
    error: 'model unavailable',
  });
});

test('parseClaudeStdout keeps the existing Claude JSONL contract', () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: 'Claude result',
    session_id: 'claude-session',
  });

  assert.deepEqual(parseClaudeStdout(stdout), {
    response: 'Claude result',
    sessionId: 'claude-session',
  });
  assert.deepEqual(parseAgentStdout('claude', stdout), parseClaudeStdout(stdout));
});
