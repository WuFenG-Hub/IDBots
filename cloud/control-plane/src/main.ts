import { loadConfig } from './config.js';
import { openDb, ensureHostRow } from './db/index.js';
import { sha256Hex } from './crypto.js';
import { DockerClient } from './docker/client.js';
import { createPublicServer, createMetricsServer } from './server.js';

/**
 * Process entry point: load config, open the database (running migrations),
 * seed the single v1 hosts row from config, and start the public + metrics
 * listeners. Graceful shutdown on SIGTERM/SIGINT.
 */

function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(':');
  return { host: listen.slice(0, idx), port: Number(listen.slice(idx + 1)) };
}

function main(): void {
  const config = loadConfig(process.env);
  const db = openDb(config.dbPath);

  const hostId = `h_${sha256Hex(config.dockerUrl).slice(0, 20)}`;
  ensureHostRow(db, {
    id: hostId,
    dockerUrl: config.dockerUrl,
    capacity: 0,
    status: 'active',
  });

  const docker = new DockerClient(config.dockerUrl);
  const publicServer = createPublicServer({ db, docker });
  const metricsServer = createMetricsServer();

  const publicListen = parseListen(config.listen);
  const metricsListen = parseListen(config.metricsListen);

  publicServer.listen(publicListen.port, publicListen.host, () => {
    console.log(JSON.stringify({ msg: 'control-plane listening', listen: config.listen }));
  });
  metricsServer.listen(metricsListen.port, metricsListen.host);

  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }));
    publicServer.close(() => {
      metricsServer.close(() => {
        db.close();
        process.exit(0);
      });
    });
    // Force-exit if sockets stay open.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
