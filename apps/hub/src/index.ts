import { bootstrap, type Hub } from './bootstrap.js';
import { loadConfig } from './config/config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const hub: Hub = await bootstrap(config);

  if (process.argv.includes('--check')) {
    console.log('[hub] boot check passed; shutting down');
    await hub.stop();
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hub] received ${signal}; shutting down`);
    await hub.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[hub] fatal:', error);
  process.exitCode = 1;
});
