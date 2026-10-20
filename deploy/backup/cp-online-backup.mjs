#!/usr/bin/env node
// Online backup of the control-plane SQLite database via VACUUM INTO
// (consistent snapshot while the control plane keeps writing), plus an
// integrity check of the produced copy. Used inside a helper container when
// the host cannot read the cp-data volume path:
//   docker run --rm -v <cp-volume>:/data -v <out-dir>:/out -v <backup-dir>:/tools:ro \
//     <image> node /tools/cp-online-backup.mjs /data/cp.sqlite /out/cp.sqlite
import { DatabaseSync } from 'node:sqlite';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: cp-online-backup.mjs SRC_DB DEST_DB');
  process.exit(2);
}

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
db.close();

const check = new DatabaseSync(dest, { readOnly: true });
const row = check.prepare('PRAGMA integrity_check').get();
check.close();
if (row?.integrity_check !== 'ok') {
  console.error(`integrity_check on copy failed: ${JSON.stringify(row)}`);
  process.exit(1);
}
console.log(`online backup ok: ${src} -> ${dest}`);
