#!/usr/bin/env node
/**
 * Standalone fake Docker Engine: node test/fake-docker/main.mjs --port 2375
 * (port 0 = ephemeral, the chosen port is printed). Image labels can be
 * seeded for a run via FAKE_DOCKER_SEED_IMAGES='{"ref":{"k":"v"}}'.
 */
import { FakeDocker } from './index.mjs';

const portFlag = process.argv.indexOf('--port');
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 0;

const docker = new FakeDocker();
try {
  const seed = JSON.parse(process.env.FAKE_DOCKER_SEED_IMAGES ?? '{}');
  for (const [ref, labels] of Object.entries(seed)) {
    docker.images.set(ref, { ref, labels });
  }
} catch (err) {
  console.error(`invalid FAKE_DOCKER_SEED_IMAGES: ${err.message}`);
  process.exit(2);
}

await docker.listen(port);
console.log(`fake docker listening on ${docker.url()}`);

const shutdown = () => {
  docker.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
