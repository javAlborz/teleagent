import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SipStateStorageError } from './state-storage-boundary.js';

const logger = createLogger();

export async function main({
  createAppImpl = createApp,
  loadConfigImpl = loadConfig,
  runtimeLogger = logger,
  runtimeProcess = process,
} = {}) {
  let config;
  try {
    config = loadConfigImpl();
  } catch (error) {
    if (error instanceof ConfigError) {
      runtimeLogger.error('Invalid Realtime SIP gateway configuration', { error: error.message });
      runtimeProcess.exitCode = 78;
      return;
    }
    throw error;
  }

  const app = await createAppImpl({ config, logger: runtimeLogger });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtimeLogger.info('Stopping Realtime SIP canary gateway', { signal });
    const forceTimer = setTimeout(() => runtimeProcess.exit(1), 15_000);
    forceTimer.unref();
    try {
      await app.close();
      clearTimeout(forceTimer);
    } catch (error) {
      runtimeLogger.error('Realtime SIP gateway shutdown failed', { error: error.message });
      runtimeProcess.exitCode = 1;
    }
  };

  // The systemd cgroup stop and its startup supervisor may both deliver the
  // signal. Keep handlers installed while the bounded close is in progress.
  runtimeProcess.on('SIGTERM', () => void shutdown('SIGTERM'));
  runtimeProcess.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen();
}

export async function runEntrypoint(options = {}) {
  const runtimeLogger = options.runtimeLogger ?? logger;
  const runtimeProcess = options.runtimeProcess ?? process;
  try {
    await main({ ...options, runtimeLogger, runtimeProcess });
  } catch (error) {
    runtimeLogger.error('Realtime SIP canary gateway failed', { error: error.message });
    runtimeProcess.exitCode = error instanceof SipStateStorageError ? 77 : 1;
  }
}

export function isMainModule({
  argvPath = process.argv[1],
  moduleUrl = import.meta.url,
  realpath = fs.realpathSync,
} = {}) {
  if (!argvPath) return false;
  try {
    return realpath(argvPath) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runEntrypoint();
}
