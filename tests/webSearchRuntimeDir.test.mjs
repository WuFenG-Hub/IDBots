import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * S2 (2026-10-22 review round 2): the web-search lazy-start wrote its
 * pid/log/connection-cache into the skill source dir, which is read-only in
 * the tenant image, so lazy-start failed with Permission denied. Runtime
 * files must live in a configurable, always-writable runtime dir.
 */

const scripts = ['start-server.sh', 'stop-server.sh', 'search.sh'];

for (const name of scripts) {
  const path = `SKILLs/web-search/scripts/${name}`;
  const source = readFileSync(path, 'utf8');

  test(`${name}: runtime files use WEB_SEARCH_RUNTIME_DIR with a writable default`, () => {
    assert.ok(
      source.includes('WEB_SEARCH_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/tmp}'),
      `${name} must default to a writable runtime dir (XDG_RUNTIME_DIR or /tmp)`,
    );
    assert.ok(source.includes('mkdir -p "$RUNTIME_DIR"'), `${name} must create the runtime dir on demand`);
    assert.ok(
      !source.includes('PID_FILE="$PROJECT_DIR/'),
      `${name} must not write the pid file into the skill source dir`,
    );
    assert.ok(
      !source.includes('LOG_FILE="$PROJECT_DIR/'),
      `${name} must not write the log file into the skill source dir`,
    );
    assert.ok(
      !source.includes('CONNECTION_CACHE="$PROJECT_DIR/'),
      `${name} must not write the connection cache into the skill source dir`,
    );
    assert.ok(
      !source.includes('"$PROJECT_DIR/.server.log"'),
      `${name} must not read the log from the skill source dir`,
    );
  });
}
