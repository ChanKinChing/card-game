// Process entry point. HTTP, authentication and socket composition live in application.ts.
import { createGameApplication } from './application';
import { serverLogger } from '@card-game/engine/shared/game-logger';
import path from 'node:path';
import { backupDatabase } from './stores/backup';
import { loadServerConfig, ConfigurationError } from './config';

async function main(): Promise<void> {
  const mode = process.argv[2];
  const environment = mode === '--lab' ? { ...process.env, NODE_ENV:'development', FRONTEND_MODE:'built', CONFIG_FILE:process.env.CONFIG_FILE ?? path.resolve(__dirname,'../../../deploy/profiles/scenario-lab.example.json') } : mode === '--vite' ? { ...process.env, FRONTEND_MODE: 'vite' } : process.env;
  const config = loadServerConfig(environment), root = path.resolve(__dirname, '..', '..', '..');
  if (mode === '--lab' && (config.navigation.purpose !== 'lab' || !config.lab.enabled || !config.inspectionEnabled)) throw new ConfigurationError('Lab startup requires explicit lab identity, scenarios and inspection.');
  const databasePath = path.resolve(root, config.storage.databasePath);
  if (mode === 'backup') {
    if (process.argv.length !== 4) throw new Error('Provide a new backup destination');
    await backupDatabase(databasePath, process.argv[3]); return;
  }
  const { port, host } = config.http;
  const { server, io, ready } = createGameApplication({ databasePath, auditPath: path.resolve(root, config.logging.auditPath), effectiveConfig: config });
  await ready;
  server.listen(port, host, () => serverLogger.info('server:listening', 'Game server started', { port, host }));
  const shutdown = () => { io.close(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
void main().catch(error => {
  serverLogger.error('server:startup:failed', error instanceof ConfigurationError ? error.message : 'Server configuration or authentication initialization failed');
  process.exitCode = 1;
});
