#!/usr/bin/env node
/**
 * Group Task attribution audit (round-4, one-shot).
 *
 * Scans every Group Task group's stored group_chat_messages and compares the
 * chain-signature-derived GlobalMetaID against the task member table:
 * - messages whose sender_global_metaid is empty are resolved from the legacy
 *   sender_metaid via manapi /api/info/metaid/{metaid};
 * - a resolved GlobalMetaID must belong to the task members (matched by
 *   GlobalMetaID — name is NEVER a member identifier) or to the owner
 *   (chair bot's boss_global_metaid), otherwise the message is SUSPECT;
 * - a message whose sender_name matches a member name but whose GlobalMetaID
 *   does NOT is a name-based misattribution (the #7 class of bug).
 *
 * Read-only by default. --apply writes the resolved GlobalMetaIDs and the
 * suspect flags back into group_chat_messages (same as the daemon does).
 *
 * Usage:
 *   node scripts/group-task-attribution-audit.mjs [--db <path>] [--apply] [--task <id>]
 *
 * Exit code: 0 = audit complete (even when findings exist); 1 = audit failed.
 */
'use strict';

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MANAPI_METAID_URL = 'https://manapi.metaid.io/api/info/metaid/';
const DEFAULT_DB = path.join(os.homedir(), 'Library/Application Support/IDBots/idbots.sqlite');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
const dbPath = argValue('--db') || DEFAULT_DB;
const apply = process.argv.includes('--apply');
const taskFilter = argValue('--task');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveGlobalMetaId(legacyMetaId, cache) {
  const key = String(legacyMetaId ?? '').trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const response = await fetch(`${MANAPI_METAID_URL}${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      cache.set(key, null);
      return null;
    }
    const json = await response.json();
    const resolved = typeof json?.data?.globalMetaId === 'string'
      ? json.data.globalMetaId.trim()
      : '';
    cache.set(key, resolved || null);
    await sleep(120); // polite rate limit
    return resolved || null;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function run() {
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  const cache = new Map();

  const tasks = db.prepare(`
    SELECT id, group_id, title, status, chair_metabot_id FROM group_tasks
    WHERE group_id IS NOT NULL AND TRIM(group_id) != ''
    ORDER BY id ASC
  `).all();
  if (taskFilter) {
    const wanted = Number(taskFilter);
    const filtered = tasks.filter((task) => task.id === wanted);
    if (filtered.length === 0) {
      console.error(`No group task with id=${taskFilter}`);
      return 1;
    }
    tasks.splice(0, tasks.length, ...filtered);
  }

  const membersStmt = db.prepare(`
    SELECT m.metabot_id, m.globalmetaid, m.role, mb.name AS metabot_name,
           mb.boss_global_metaid AS owner_gmid
    FROM group_task_members m
    LEFT JOIN metabots mb ON mb.id = m.metabot_id
    WHERE m.task_id = ?
  `);
  const messagesStmt = db.prepare(`
    SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, chain_timestamp,
           substr(content, 1, 60) AS content_snippet
    FROM group_chat_messages WHERE group_id = ? ORDER BY id ASC
  `);

  const report = [];
  let totalMessages = 0;
  let okMember = 0;
  let okOwner = 0;
  let suspect = 0;
  let unresolved = 0;
  let nameConflict = 0;
  let repaired = 0;

  for (const task of tasks) {
    const members = membersStmt.all(task.id);
    const memberByGmid = new Map();
    const memberNames = new Set();
    for (const member of members) {
      const gmid = String(member.globalmetaid ?? '').trim().toLowerCase();
      if (gmid) memberByGmid.set(gmid, member);
      if (member.metabot_name) memberNames.add(String(member.metabot_name).trim().toLowerCase());
    }
    const ownerGmid = String(members.find((m) => m.role === 'chair')?.owner_gmid ?? '').trim().toLowerCase();
    const chairName = members.find((m) => m.role === 'chair')?.metabot_name ?? null;

    const messages = messagesStmt.all(task.group_id);
    const taskFindings = [];
    for (const message of messages) {
      totalMessages += 1;
      const id = message.id;
      const legacy = String(message.sender_metaid ?? '').trim();
      let gmid = String(message.sender_global_metaid ?? '').trim();
      let resolvedFromLegacy = false;
      if (!gmid && legacy) {
        const resolved = await resolveGlobalMetaId(legacy, cache);
        if (resolved) {
          gmid = resolved;
          resolvedFromLegacy = true;
          if (apply) {
            db.prepare('UPDATE group_chat_messages SET sender_global_metaid = ? WHERE id = ?')
              .run(gmid, id);
            repaired += 1;
          }
        }
      }
      const gmidKey = gmid.toLowerCase();
      const isMember = memberByGmid.has(gmidKey);
      const isOwner = Boolean(ownerGmid && gmidKey === ownerGmid);
      const verdict = isMember ? 'MEMBER' : isOwner ? 'OWNER' : gmid ? 'SUSPECT' : 'UNRESOLVED';

      // Name-based misattribution: the display name says member X, the chain
      // signature says someone else (or nobody) — the #7 class of bug.
      const nameSaysMember = memberNames.has(String(message.sender_name ?? '').trim().toLowerCase());
      const conflict = nameSaysMember && !isMember && !isOwner;
      if (conflict) nameConflict += 1;

      if (verdict === 'MEMBER') okMember += 1;
      else if (verdict === 'OWNER') okOwner += 1;
      else if (verdict === 'SUSPECT') suspect += 1;
      else unresolved += 1;

      if (apply && (verdict === 'SUSPECT' || verdict === 'UNRESOLVED')) {
        db.prepare('UPDATE group_chat_messages SET sender_suspect = 1 WHERE id = ?').run(id);
        repaired += 1;
      }

      if (verdict !== 'MEMBER' && verdict !== 'OWNER' || conflict) {
        taskFindings.push({
          id,
          name: message.sender_name ?? '(none)',
          legacy: legacy ? `${legacy.slice(0, 12)}…` : '(none)',
          gmid: gmid || '(unresolved)',
          resolvedFromLegacy,
          verdict,
          conflict,
          snippet: message.content_snippet ?? '',
        });
      }
    }
    report.push({ task, chairName, members, messages: taskFindings });
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const lines = [];
  lines.push('# Group Task attribution audit (round-4)');
  lines.push('');
  lines.push(`- DB: ${dbPath}`);
  lines.push(`- Apply: ${apply ? 'YES (resolved gmids + suspect flags written back)' : 'no (read-only)'}`);
  lines.push(`- Tasks: ${tasks.length}`);
  lines.push(`- Messages: ${totalMessages}`);
  lines.push(`- MEMBER: ${okMember} · OWNER: ${okOwner} · SUSPECT: ${suspect} · UNRESOLVED: ${unresolved}`);
  lines.push(`- Name-vs-chain conflicts: ${nameConflict}`);
  lines.push('');
  for (const entry of report) {
    const { task, chairName, members, messages } = entry;
    lines.push(`## Task #${task.id} — ${task.title} (${task.status})`);
    lines.push('');
    lines.push(`- groupId: ${task.group_id}`);
    lines.push(`- chair: ${chairName ?? '(unknown)'} · owner GlobalMetaID: ${members.find((m) => m.role === 'chair')?.owner_gmid ?? '(none)'}`);
    lines.push(`- members: ${members.map((m) => `${m.metabot_name ?? '(remote)'}[${m.role}]${m.globalmetaid ? ` ${m.globalmetaid}` : ' (no gmid)'}`).join(', ')}`);
    if (messages.length === 0) {
      lines.push('- no attribution findings');
    } else {
      lines.push(`- findings: ${messages.length}`);
      for (const finding of messages) {
        const conflictMark = finding.conflict ? ' ⚠ name/chain conflict' : '';
        lines.push(
          `  - msg#${finding.id} name="${finding.name}" legacy=${finding.legacy} ` +
          `globalMetaId=${finding.gmid}${finding.resolvedFromLegacy ? ' (resolved from legacy)' : ''} ` +
          `→ ${finding.verdict}${conflictMark}`,
        );
        lines.push(`    content: ${finding.snippet}`);
      }
    }
    lines.push('');
  }
  const markdown = lines.join('\n');
  console.log(markdown);

  const outPath = argValue('--out');
  if (outPath) {
    import('node:fs').then((fs) => {
      fs.writeFileSync(outPath, markdown);
      console.log(`\nReport written to ${outPath}`);
    });
  }
  return 0;
}

run().then((code) => process.exit(code)).catch((error) => {
  console.error(`Audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
