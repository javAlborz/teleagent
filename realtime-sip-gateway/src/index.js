import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger();

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error('Invalid Realtime SIP gateway configuration', { error: error.message });
      process.exitCode = 78;
      return;
    }
    throw error;
  }

  const app = await createApp({ config, logger });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Stopping Realtime SIP canary gateway', { signal });
    const forceTimer = setTimeout(() => process.exit(1), 15_000);
    forceTimer.unref();
    try {
      await app.close();
      clearTimeout(forceTimer);
    } catch (error) {
      logger.error('Realtime SIP gateway shutdown failed', { error: error.message });
      process.exitCode = 1;
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  await app.listen();
}

main().catch((error) => {
  logger.error('Realtime SIP canary gateway failed', { error: error.message });
  process.exitCode = 1;
});
