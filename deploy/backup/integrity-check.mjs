#!/usr/bin/env node
// Runs PRAGMA integrity_check on every *.sqlite under a root directory.
// Used inside a helper container when the host cannot read a docker volume
// path (Docker Desktop, remote docker):
//   docker run --rm -v <volume>:/data -v <backup-dir>:/tools:ro <image> \
//     node /tools/integrity-check.mjs /data
// Prints one line per database; exit 1 if any check fails, 0 otherwise.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.argv[2] || '/data';
const dbs = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    try {
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith('.sqlite') && !entry.startsWith('._')) dbs.push(p);
    } catch { /* transient files */ }
  }
})(root);

let failed = 0;
for (const db of dbs) {
  try {
    // Read-write open is deliberate: an archived WAL must recover on first
    // open, and proving recovery works is part of the check.
    const d = new DatabaseSync(db);
    const row = d.prepare('PRAGMA integrity_check').get();
    d.close();
    const ok = row?.integrity_check === 'ok';
    console.log(`${ok ? 'ok' : 'FAILED'} ${db}${ok ? '' : ' -> ' + JSON.stringify(row)}`);
    if (!ok) failed++;
  } catch (err) {
    console.log(`FAILED ${db} -> ${err.message}`);
    failed++;
  }
}
if (!dbs.length) console.log(`no .sqlite files under ${root} — nothing checked`);
process.exit(failed ? 1 : 0);
