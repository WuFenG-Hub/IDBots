#!/usr/bin/env node
/**
 * Group Task episode readability repair + archive export (P0-7, one-shot).
 *
 * For every Group Task group:
 *  - audits the stored group_chat_messages for unreadable bodies (NULL/empty
 *    content, or AES ciphertext that was never decrypted);
 *  - with --apply, attempts to decrypt AES bodies in place using the same
 *    group key derivation as groupChatBackfillService (group_id[0:16]);
 *  - writes a structured archive (index + full bodies + daily summary) per
 *    task as JSON to --out (default ./group-task-exports).
 *
 * The script is best-effort and honest: messages whose bodies are unavailable
 * locally (never backfilled, SESSION_NOT_FOUND history) are reported as
 * "unfixable" rather than fabricated.
 *
 * Usage:
 *   node scripts/group-task-episode-repair.mjs [--db <path>] [--apply] [--task <id>] [--out <dir>]
 *
 * Exit code: 0 = completed (findings may exist); 1 = failed.
 */
'use strict';

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB = path.join(os.homedir(), 'Library/Application Support/IDBots/idbots.sqlite');
const DEFAULT_OUT = path.join(process.cwd(), 'group-task-exports');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
const dbPath = argValue('--db') || DEFAULT_DB;
const apply = process.argv.includes('--apply');
const taskFilter = argValue('--task');
const outDir = argValue('--out') || DEFAULT_OUT;

async function loadDecrypt() {
  // Best-effort: compiled electron main is required for AES decryption. When
  // dist-electron is absent (fresh clone), the script degrades to audit+export.
  try {
    const { decryptGroupMessage } = await import(
      new URL('../dist-electron/main/services/metaWebCrypto.js', import.meta.url).href
    );
    return decryptGroupMessage;
  } catch {
    return null;
  }
}

async function run() {
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  const decryptGroupMessage = await loadDecrypt();

  const tasks = db.prepare(`
    SELECT id, group_id, title, status FROM group_tasks
    WHERE group_id IS NOT NULL AND TRIM(group_id) != ''
    ORDER BY id ASC
  `).all();
  if (taskFilter) {
    const wanted = Number(taskFilter);
    const filtered = tasks.filter((task) => task.id === wanted);
    if (filtered.length === 0) {
      console.error(`No group task with id ${taskFilter}`);
      db.close();
      process.exit(1);
    }
    tasks.splice(0, tasks.length, ...filtered);
  }

  if (tasks.length === 0) {
    console.log('No group tasks to process.');
    db.close();
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  let totalUnreadable = 0;
  let totalRepaired = 0;
  const report = [];

  for (const task of tasks) {
    const messages = db.prepare(`
      SELECT id, pin_id, sender_name, sender_global_metaid, content, content_type,
             encryption, chain_timestamp, msg_index, reply_pin, sender_suspect
      FROM group_chat_messages
      WHERE group_id = ?
      ORDER BY id ASC
    `).all(task.group_id);

    let emptyBodies = 0;
    let repaired = 0;
    const unreadable = [];
    for (const message of messages) {
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content) {
        emptyBodies += 1;
        unreadable.push({ id: message.id, pinId: message.pin_id, reason: 'empty body' });
        continue;
      }
      const encrypted = typeof message.encryption === 'string'
        && /aes/i.test(message.encryption);
      // Decrypted bodies are natural text; AES ciphertext is dense base64
      // (no whitespace, 40+ chars). Backfill keeps encryption='aes' even after
      // decrypting, so the content shape is the reliable signal.
      const looksLikeCiphertext = encrypted
        && content.length > 40
        && /^[A-Za-z0-9+/=]{40,}$/.test(content)
        && !/\s/.test(content);
      if (looksLikeCiphertext) {
        if (apply && decryptGroupMessage) {
          try {
            const decrypted = decryptGroupMessage(content, task.group_id.substring(0, 16));
            if (decrypted && decrypted.trim() && decrypted !== content) {
              db.prepare('UPDATE group_chat_messages SET content = ?, encryption = ? WHERE id = ?')
                .run(decrypted, 'plain', message.id);
              repaired += 1;
            } else {
              unreadable.push({ id: message.id, pinId: message.pin_id, reason: 'decrypt no-op' });
            }
          } catch {
            unreadable.push({ id: message.id, pinId: message.pin_id, reason: 'decrypt failed' });
          }
        } else {
          unreadable.push({ id: message.id, pinId: message.pin_id, reason: 'aes ciphertext' });
        }
      }
    }

    // Structured archive: index + full bodies + daily summary.
    const byDay = new Map();
    for (const message of messages) {
      if (message.chain_timestamp == null) continue;
      const date = new Date(message.chain_timestamp * 1000).toISOString().slice(0, 10);
      const entry = byDay.get(date) ?? { count: 0, firstAt: null, lastAt: null };
      entry.count += 1;
      entry.firstAt = entry.firstAt == null ? message.chain_timestamp : Math.min(entry.firstAt, message.chain_timestamp);
      entry.lastAt = entry.lastAt == null ? message.chain_timestamp : Math.max(entry.lastAt, message.chain_timestamp);
      byDay.set(date, entry);
    }
    const archive = {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        groupId: task.group_id,
      },
      messages,
      dailySummaries: [...byDay.entries()]
        .map(([date, entry]) => ({ date, ...entry }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
      unreadable,
      exportedAt: new Date().toISOString(),
    };
    const file = path.join(outDir, `group-task-${task.id}.json`);
    fs.writeFileSync(file, JSON.stringify(archive, null, 2));

    totalUnreadable += unreadable.length;
    totalRepaired += repaired;
    report.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      messages: messages.length,
      unreadable: unreadable.length,
      repaired,
      archiveFile: file,
    });
    console.log(
      `Task #${task.id} "${task.title}": ${messages.length} messages, ` +
      `${unreadable.length} unreadable, ${repaired} repaired${apply ? '' : ' (run with --apply to repair AES bodies)'}`,
    );
  }

  console.log(`\nSummary: ${tasks.length} tasks, ${totalUnreadable} unreadable bodies, ${totalRepaired} repaired.`);
  console.log(`Archives written to ${outDir}`);
  if (apply) db.close();
  else db.close();
}

run().catch((error) => {
  console.error('group-task-episode-repair failed:', error);
  process.exit(1);
});
