#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require(path.join(__dirname, '..', 'voice-app', 'node_modules', 'better-sqlite3'));

function parseArgs(argv) {
  const options = { latest: true, json: false, limit: 500, output: null, session: null, thread: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--session') options.session = argv[++index];
    else if (arg === '--thread') options.thread = argv[++index];
    else if (arg === '--limit') options.limit = Math.max(1, Math.min(Number.parseInt(argv[++index], 10) || 500, 10000));
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: npm run voice-history -- [--session ID | --thread ID] [--limit N] [--json] [--output FILE]\n` +
    `Defaults to the most recently opened Realtime call. Output contains exact text events, jobs, operation audit records, and measured token usage; raw audio is never recorded.\n`;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const dbPath = path.resolve(process.env.VOICE_STATE_DB_PATH || path.join(projectRoot, 'voice-app', 'state', 'voice-state.sqlite'));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let session = null;
    if (options.session) {
      session = db.prepare('SELECT * FROM realtime_sessions WHERE id = ?').get(options.session);
    } else if (options.thread) {
      session = db.prepare('SELECT * FROM realtime_sessions WHERE voice_thread_id = ? ORDER BY opened_at DESC LIMIT 1').get(options.thread);
    } else {
      session = db.prepare('SELECT * FROM realtime_sessions ORDER BY opened_at DESC LIMIT 1').get();
    }
    if (!session) throw new Error('No matching Realtime session was found.');

    const events = db.prepare(`
      SELECT id, role, kind, content, created_at
      FROM voice_events WHERE realtime_session_id = ? ORDER BY id LIMIT ?
    `).all(session.id, options.limit);
    const jobs = db.prepare(`
      SELECT id, profile, status, request, voice_result, error, created_at, started_at, completed_at
      FROM jobs WHERE realtime_session_id = ? ORDER BY created_at
    `).all(session.id);
    const audit = tableExists(db, 'operation_audit')
      ? db.prepare(`
          SELECT event_id, job_id, action, risk_level, profile, scope_text, metadata_json, created_at
          FROM operation_audit WHERE realtime_session_id = ? ORDER BY id
        `).all(session.id).map((entry) => ({
          ...entry,
          metadata: JSON.parse(entry.metadata_json || '{}'),
          metadata_json: undefined,
        }))
      : [];
    const usageRows = tableExists(db, 'realtime_usage')
      ? db.prepare(`
          SELECT kind, model, usage_json, created_at
          FROM realtime_usage WHERE realtime_session_id = ? ORDER BY id
        `).all(session.id).map((entry) => ({
          ...entry,
          usage: JSON.parse(entry.usage_json || '{}'),
          usage_json: undefined,
        }))
      : [];
    const usageTotals = usageRows.reduce((totals, entry) => {
      const details = entry.usage || {};
      totals.total_tokens += Number(details.total_tokens || 0);
      totals.input_tokens += Number(details.input_tokens || 0);
      totals.output_tokens += Number(details.output_tokens || 0);
      totals.cached_input_tokens += Number(details.input_token_details?.cached_tokens || 0);
      return totals;
    }, { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
    const payload = { session, events, jobs, audit, usage: usageRows, usage_totals: usageTotals, raw_audio_recorded: false };

    let rendered;
    if (options.json) {
      rendered = `${JSON.stringify(payload, null, 2)}\n`;
    } else {
      const lines = [
        `Session ${session.id}`,
        `Call ${session.call_id} | ${session.opened_at} → ${session.closed_at || 'OPEN'} | ${session.status}`,
        '',
        ...events.map((event) => `${event.created_at}  ${event.role}/${event.kind}: ${event.content.replaceAll(/\s+/g, ' ')}`),
      ];
      if (jobs.length > 0) {
        lines.push('', 'Jobs:', ...jobs.map((job) => (
          `${job.id}  ${job.profile}  ${job.status}  ${job.voice_result || job.error || job.request}`
        )));
      }
      if (audit.length > 0) {
        lines.push('', 'Operation audit:', ...audit.map((entry) => (
          `${entry.created_at}  ${entry.action}  ${entry.risk_level}  ${entry.job_id || '-'}  ${entry.scope_text || ''}`
        )));
      }
      if (usageRows.length > 0) {
        lines.push(
          '',
          'Measured usage:',
          `${usageTotals.total_tokens} total tokens | ${usageTotals.input_tokens} input | ${usageTotals.output_tokens} output | ${usageTotals.cached_input_tokens} cached input`,
          'Remaining OpenAI project budget is not exposed to this local ledger.'
        );
      }
      rendered = `${lines.join('\n')}\n`;
    }

    if (options.output) {
      const outputPath = path.resolve(options.output);
      fs.writeFileSync(outputPath, rendered, { mode: 0o600 });
      process.stdout.write(`${outputPath}\n`);
    } else {
      process.stdout.write(rendered);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`voice-history: ${error.message}\n`);
  process.exitCode = 1;
}
