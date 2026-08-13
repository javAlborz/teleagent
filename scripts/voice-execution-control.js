#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function request({ method, pathname, token = null, body = null }) {
  return new Promise((resolve, reject) => {
    const serialized = body ? JSON.stringify(body) : '';
    const headers = {};
    if (serialized) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = http.request({
      hostname: '127.0.0.1',
      port: Number.parseInt(process.env.HTTP_PORT || '3000', 10),
      method,
      path: pathname,
      headers,
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Preserve non-JSON errors for the operator.
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Voice control request timed out')));
    req.on('error', reject);
    if (serialized) req.write(serialized);
    req.end();
  });
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  loadEnvFile(path.join(projectRoot, '.env'));
  const command = String(process.argv[2] || 'status').toLowerCase();

  if (!['status', 'unlock'].includes(command)) {
    throw new Error('Usage: npm run voice-control -- status|unlock');
  }

  const token = String(
    process.env.VOICE_CONTROL_TOKEN ||
    process.env.OUTBOUND_API_TOKEN ||
    process.env.AGENT_API_TOKEN ||
    process.env.CLAUDE_API_TOKEN ||
    ''
  ).trim();
  if (command === 'unlock' && !token) {
    throw new Error('VOICE_CONTROL_TOKEN, OUTBOUND_API_TOKEN, or AGENT_API_TOKEN is required to unlock');
  }

  const result = command === 'status'
    ? await request({ method: 'GET', pathname: '/api/voice-control/status' })
    : await request({
      method: 'POST',
      pathname: '/api/voice-control/unlock',
      token,
      body: { source: 'operator_cli' },
    });

  process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  if (result.statusCode < 200 || result.statusCode >= 300) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Voice control failed: ${error.message}\n`);
  process.exitCode = 1;
});
