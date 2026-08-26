#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildClaudeArgs,
  buildCodexArgs,
} = require('../claude-api-server/agent-cli');

const SAFE_HEADER_VALUES = new Set([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'openai-beta',
  'originator',
  'user-agent',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
]);
const SAFE_BODY_STRING_KEYS = new Set([
  'effort',
  'format',
  'model',
  'name',
  'role',
  'syntax',
  'tool_choice',
  'type',
  'verbosity',
]);

function fail(message) {
  process.stderr.write(`Offline provider capture refused: ${message}\n`);
  process.exit(1);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail('options must be name/value pairs');
    if (Object.hasOwn(options, name)) fail(`duplicate option: ${name}`);
    options[name] = value;
  }
  const provider = options['--provider'];
  const command = path.resolve(String(options['--command'] || ''));
  const model = String(options['--model'] || '');
  const effort = String(options['--effort'] || 'low');
  if (!['claude', 'codex'].includes(provider) || !model || !path.isAbsolute(command) ||
      !fs.existsSync(command)) {
    fail('use --provider claude|codex --command ABSOLUTE_PATH --model MODEL [--effort EFFORT]');
  }
  const metadata = fs.lstatSync(command);
  if ((!metadata.isFile() && !metadata.isSymbolicLink()) || (metadata.mode & 0o111) === 0) {
    fail('the selected CLI is not executable');
  }
  return {
    provider,
    command,
    model,
    effort,
    summary: options['--output'] === 'summary',
  };
}

function redactedString(value) {
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `<redacted:${Buffer.byteLength(value)}:${digest}>`;
}

function sanitizeBody(value, key = '', parentKey = '') {
  if (typeof value === 'string') {
    // reasoning.context is a bounded provider control enum, not prompt text.
    // Keep this one path visible so the pinned broker contract can be derived
    // without weakening redaction for arbitrary fields named "context".
    return SAFE_BODY_STRING_KEYS.has(key) || (parentKey === 'reasoning' && key === 'context')
      ? value
      : redactedString(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeBody(entry, key, parentKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => (
      [childKey, sanitizeBody(childValue, childKey, key)]
    )));
  }
  return value;
}

function sanitizeHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (['authorization', 'cookie', 'proxy-authorization', 'x-api-key'].includes(normalized)) {
      result[normalized] = '<redacted-auth-header>';
    } else if (SAFE_HEADER_VALUES.has(normalized)) {
      result[normalized] = String(value);
    } else {
      result[normalized] = '<value-omitted>';
    }
  }
  return result;
}

function summarizeInputItem(item) {
  if (!item || typeof item !== 'object') return { valueType: typeof item };
  return {
    type: item.type || null,
    role: item.role || null,
    contentTypes: Array.isArray(item.content)
      ? item.content.map((entry) => entry?.type || typeof entry)
      : [],
    toolTypes: Array.isArray(item.tools)
      ? item.tools.flatMap((entry) => [
        entry?.type || null,
        ...(Array.isArray(entry?.tools) ? entry.tools.map((child) => child?.type || null) : []),
      ]).filter(Boolean)
      : [],
  };
}

function summarizeCapture(captured) {
  return {
    version: captured.version,
    provider: captured.provider,
    model: captured.model,
    reasoningEffort: captured.reasoningEffort,
    requests: captured.requests.map((request) => ({
      method: request.method,
      path: request.path,
      query: request.query,
      headerNames: Object.keys(request.headers).sort(),
      protocolHeaders: Object.fromEntries(Object.entries(request.headers).filter(([name]) => (
        ['anthropic-beta', 'anthropic-version', 'content-type', 'originator', 'user-agent']
          .includes(name)
      ))),
      topLevelKeys: Object.keys(request.body || {}).sort(),
      bodyContract: {
        model: request.body?.model || null,
        max_tokens: request.body?.max_tokens ?? null,
        reasoning: request.body?.reasoning || null,
        thinking: request.body?.thinking || null,
        output_config: request.body?.output_config || null,
        text: request.body?.text || null,
        store: request.body?.store ?? null,
        stream: request.body?.stream ?? null,
        tool_choice: request.body?.tool_choice ?? null,
        parallel_tool_calls: request.body?.parallel_tool_calls ?? null,
        input: Array.isArray(request.body?.input)
          ? request.body.input.map(summarizeInputItem)
          : [],
      },
    })),
    cliExit: captured.cliExit,
  };
}

function signalChildTree(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let completed = false;
    const finish = (value) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      signalChildTree(child, 'SIGKILL');
      finish({ code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
    child.once('error', (error) => finish({ error: error.message }));
    child.once('exit', (code, signal) => finish({ code, signal, timedOut: false }));
  });
}

function sanitizeDiagnostic(value, temporaryRoot) {
  return String(value || '')
    .replaceAll(temporaryRoot, '<temporary-root>')
    .replaceAll('teleagent-local-provider-key', '<redacted-sentinel>')
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._~-]+/giu, '<redacted-auth>')
    .slice(-4096)
    .trim();
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-provider-capture-'));
  const workspace = path.join(temporaryRoot, 'workspace');
  const home = path.join(temporaryRoot, 'home');
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(home, '.claude'), { mode: 0o700 });
  fs.mkdirSync(path.join(home, '.codex'), { mode: 0o700 });
  fs.writeFileSync(path.join(temporaryRoot, 'empty-settings.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(temporaryRoot, 'empty-mcp.json'), '{"mcpServers":{}}\n', { mode: 0o600 });

  const captured = {
    version: 1,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.provider === 'codex' ? options.effort : null,
    requests: [],
  };
  let terminalCaptured = false;
  let captureResolve;
  const capturedPromise = new Promise((resolve) => { captureResolve = resolve; });
  const server = http.createServer((request, response) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      const parsedUrl = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'HEAD' && parsedUrl.pathname === '/api/hello') {
        response.writeHead(200, { connection: 'close' });
        response.end();
        return;
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { body = { invalid_json_bytes: length }; }
      captured.requests.push({
        method: request.method,
        path: parsedUrl.pathname,
        query: [...parsedUrl.searchParams.entries()],
        headers: sanitizeHeaders(request.headers),
        body: sanitizeBody(body),
      });
      if (parsedUrl.pathname.endsWith('/messages/count_tokens')) {
        const countBody = Buffer.from('{"input_tokens":1}');
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': countBody.length,
          connection: 'close',
        });
        response.end(countBody);
        return;
      }
      const isTerminalRoute = parsedUrl.pathname.endsWith('/messages') ||
        parsedUrl.pathname.endsWith('/responses') ||
        parsedUrl.pathname.endsWith('/responses/compact');
      if (isTerminalRoute && !terminalCaptured) {
        terminalCaptured = true;
        captureResolve(captured);
      }
      const errorBody = Buffer.from(JSON.stringify({
        error: { type: 'offline_capture_complete', message: 'Synthetic upstream stopped after capture.' },
      }));
      response.writeHead(422, {
        'content-type': 'application/json',
        'content-length': errorBody.length,
        connection: 'close',
      });
      response.end(errorBody);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const safePath = `${path.dirname(options.command)}:/usr/local/bin:/usr/bin:/bin`;
  let args;
  let environment;
  if (options.provider === 'claude') {
    args = buildClaudeArgs({
      model: options.model,
      permissionMode: 'dontAsk',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep'],
    });
    args = args.map((entry) => {
      if (entry.endsWith('/empty-mcp.json')) return path.join(temporaryRoot, 'empty-mcp.json');
      if (entry.endsWith('/empty-settings.json')) return path.join(temporaryRoot, 'empty-settings.json');
      return entry;
    });
    environment = {
      PATH: safePath,
      HOME: home,
      USER: 'teleagent-capture',
      LOGNAME: 'teleagent-capture',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'teleagent-local-provider-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    };
  } else {
    args = [
      '-c', 'model_provider="teleagent-capture"',
      '-c', 'model_providers.teleagent-capture.name="Teleagent offline capture"',
      '-c', `model_providers.teleagent-capture.base_url="${baseUrl}/v1"`,
      '-c', 'model_providers.teleagent-capture.wire_api="responses"',
      '-c', 'model_providers.teleagent-capture.env_key="TELEAGENT_LOCAL_PROVIDER_KEY"',
      '-c', 'model_providers.teleagent-capture.requires_openai_auth=false',
      '-c', 'model_providers.teleagent-capture.supports_websockets=false',
      ...buildCodexArgs({
        model: options.model,
        reasoningEffort: options.effort,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        workingDirectory: workspace,
      }),
    ];
    environment = {
      PATH: safePath,
      HOME: home,
      USER: 'teleagent-capture',
      LOGNAME: 'teleagent-capture',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CODEX_HOME: path.join(home, '.codex'),
      TELEAGENT_LOCAL_PROVIDER_KEY: 'teleagent-local-provider-key',
    };
  }

  const child = spawn(options.command, args, {
    cwd: workspace,
    env: environment,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => {
    if (childStderr.length < 16384) childStderr += chunk.toString('utf8');
  });
  child.stdin.end('Reply exactly OFFLINE_CAPTURE_OK. Do not use tools.\n');
  const captureTimeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the CLI did not reach the synthetic upstream')),
      12000
    );
    timer.unref();
  });
  try {
    await Promise.race([capturedPromise, captureTimeout]);
    signalChildTree(child, 'SIGTERM');
    const exit = await waitForExit(child, 2000);
    captured.cliExit = exit;
    const output = options.summary ? summarizeCapture(captured) : captured;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    const diagnostic = sanitizeDiagnostic(childStderr, temporaryRoot);
    throw new Error(`${error.message}${diagnostic ? `; CLI diagnostic: ${diagnostic}` : ''}`);
  } finally {
    signalChildTree(child, 'SIGKILL');
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
