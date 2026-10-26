#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('Usage: node inspect-session.mjs <session-id>');
  process.exit(1);
}

async function main() {
  const userDataPath = path.join(process.env.HOME, 'Library', 'Application Support', 'IDBots');
  const dbPath = path.join(userDataPath, 'database.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  // Get session info
  const session = db.prepare('SELECT * FROM cowork_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    console.error(`Session ${sessionId} not found`);
    db.close();
    process.exit(1);
  }

  console.log('=== Session Info ===');
  console.log(JSON.stringify(session, null, 2));
  console.log('');

  // Get all messages
  const messages = db.prepare(`
    SELECT * FROM cowork_messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId);

  console.log(`=== Messages (${messages.length} total) ===`);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`\n[${i + 1}/${messages.length}] ${msg.created_at} | ${msg.role} | ${msg.id}`);

    if (msg.content) {
      const lines = msg.content.split('\n');
      const preview = lines.slice(0, 10).join('\n');
      console.log(`Content (${msg.content.length} chars, ${lines.length} lines):`);
      console.log(preview);
      if (lines.length > 10) {
        console.log(`... (${lines.length - 10} more lines)`);
      }
    }

    if (msg.tool_calls) {
      try {
        const calls = JSON.parse(msg.tool_calls);
        console.log(`Tool calls: ${calls.length} calls`);
        calls.forEach((call, idx) => {
          console.log(`  [${idx + 1}] ${call.function?.name || 'unknown'}`);
        });
      } catch (e) {
        console.log(`Tool calls (raw): ${msg.tool_calls.substring(0, 200)}`);
      }
    }
  }

  // Check for any related scheduled tasks or metatasks
  console.log('\n=== Related Scheduled Tasks ===');
  const scheduledTasks = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE created_at > datetime('now', '-2 hours')
    ORDER BY created_at DESC
  `).all();
  console.log(`Found ${scheduledTasks.length} recent scheduled tasks`);
  scheduledTasks.forEach(task => {
    console.log(`  - ${task.id}: ${task.name} (${task.status})`);
  });

  console.log('\n=== Related MetaTasks ===');
  const metaTasks = db.prepare(`
    SELECT * FROM metatasks
    WHERE created_at > datetime('now', '-2 hours')
    ORDER BY created_at DESC
    LIMIT 20
  `).all();
  console.log(`Found ${metaTasks.length} recent metatasks`);
  metaTasks.forEach(task => {
    console.log(`  - ${task.id}: ${task.title} (${task.status}) - worker: ${task.worker_metabot_id || 'none'}`);
  });

  db.close();
}

main().catch(console.error);
