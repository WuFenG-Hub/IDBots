#!/usr/bin/env node
/**
 * metabot-group-task skill script: forward Group Task commands to the local
 * IDBots RPC gateway (no chain logic here; the main process owns pins/storage).
 *
 * Usage:
 *   node index.js --payload '<JSON string>'
 *   node index.js --payload @/path/to/payload.json
 *   echo '<JSON string>' | node index.js
 *
 * Payload: { action: 'create'|'propose'|'list'|'show'|'member_status'|'send'|'invite'|'kick'|'close'|'supervise'|'search_candidates'|'search_remote'|'invite_remote', ... }
 * RPC base: process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200'
 */
'use strict';

const fs = require('fs');

const RPC_URL = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/$/, '');
function resolveRpcToken(env) {
  const fromEnv = String(env.IDBOTS_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  // DSH sessions scrub *TOKEN* env names from bash; fall back to the
  // host-written token mirror file (path rides the scrub-proof AUTHFILE name).
  const authFile = String(env.IDBOTS_RPC_AUTHFILE || '').trim();
  if (!authFile) return '';
  try {
    return require('fs').readFileSync(authFile, 'utf8').trim();
  } catch {
    return '';
  }
}
const RPC_TOKEN = resolveRpcToken(process.env);
function rpcHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (RPC_TOKEN) headers.Authorization = `Bearer ${RPC_TOKEN}`;
  return headers;
}

const ACTION_PATHS = {
  create: '/api/idbots/group-task/create',
  propose: '/api/idbots/group-task/propose-staffing',
  list: '/api/idbots/group-task/list',
  show: '/api/idbots/group-task/show',
  member_status: '/api/idbots/group-task/member-status',
  send: '/api/idbots/group-task/send',
  invite: '/api/idbots/group-task/invite',
  kick: '/api/idbots/group-task/kick-member',
  close: '/api/idbots/group-task/close',
  supervise: '/api/idbots/group-task/supervise',
  'deliverable-delete': '/api/idbots/group-task/deliverable-delete',
  search_remote: '/api/idbots/group-task/search-remote-candidates',
  search_candidates: '/api/idbots/group-task/search-candidates',
  invite_remote: '/api/idbots/group-task/invite-remote',
  bots: '/api/idbots/list-metabots',
};

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parsePayload() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--payload' && args[i + 1]) {
      let raw = args[i + 1].trim();
      // @file syntax: read the JSON payload from a file (avoids shell quoting issues).
      if (raw.startsWith('@')) {
        raw = fs.readFileSync(raw.slice(1), 'utf-8').trim();
      }
      return raw;
    }
  }
  return fs.readFileSync(0, 'utf-8').trim();
}

async function postJson(path, body) {
  const res = await fetch(`${RPC_URL}${path}`, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success !== true) {
    fail((json && json.error) || `RPC ${path} failed with HTTP ${res.status}`);
  }
  return json;
}

async function main() {
  const raw = parsePayload();
  let params;
  try {
    params = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON: ${e instanceof Error ? e.message : e}`);
  }

  const action = String(params.action ?? '').trim();
  const path = ACTION_PATHS[action];
  if (!path) {
    fail(`action must be one of: ${Object.keys(ACTION_PATHS).join(', ')}`);
  }

  let body;
  switch (action) {
    case 'bots': {
      body = {};
      break;
    }
    case 'propose': {
      const title = String(params.title ?? '').trim();
      const goal = String(params.goal ?? '').trim();
      if (!title || !goal) fail('title and goal are required for propose');
      const sourceSessionId = String(params.source_session_id ?? process.env.IDBOTS_COWORK_SESSION_ID ?? '').trim();
      if (!sourceSessionId) fail('source_session_id is required for propose');
      body = {
        title,
        goal,
        acceptance_criteria: params.acceptance_criteria,
        plan: params.plan,
        source_session_id: sourceSessionId,
        language: params.language === 'en' || params.language === 'zh' ? params.language : undefined,
      };
      break;
    }
    case 'create': {
      const title = String(params.title ?? '').trim();
      const goal = String(params.goal ?? '').trim();
      if (!title || !goal) fail('title and goal are required for create');
      const proposalId = Number(params.proposal_id);
      if (!Number.isInteger(proposalId) || proposalId <= 0) {
        fail('proposal_id is required for create — propose the roster and wait for owner confirm first');
      }
      // P1/P4: forward the originating CoWork session (explicit payload wins;
      // env fallback covers hosts that inject IDBOTS_COWORK_SESSION_ID into
      // skill subprocesses). The task close-out relays the acceptance notice
      // back to this session — without it the relay degrades.
      const sourceSessionId = String(params.source_session_id ?? process.env.IDBOTS_COWORK_SESSION_ID ?? '').trim();
      body = {
        title,
        goal,
        acceptance_criteria: params.acceptance_criteria,
        member_metabot_ids: Array.isArray(params.member_metabot_ids) ? params.member_metabot_ids : undefined,
        member_names: Array.isArray(params.member_names) ? params.member_names : undefined,
        proposal_id: proposalId,
        ...(sourceSessionId ? { source_session_id: sourceSessionId } : {}),
        // The twin bot runs this skill, so it is the default creator/chair.
        created_by: params.created_by === 'user' ? 'user' : 'twinbot',
      };
      break;
    }
    case 'list': {
      body = {};
      if (typeof params.status === 'string' && params.status.trim()) {
        body.status = params.status.trim();
      }
      break;
    }
    case 'show': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for show');
      body = { task_id: taskId };
      // Round-4: view=summary (default) keeps the output small; view=full returns everything.
      const view = String(params.view ?? '').trim();
      body.view = view === 'full' ? 'full' : 'summary';
      if (params.before_id !== undefined) {
        const beforeId = Number(params.before_id);
        if (!Number.isInteger(beforeId) || beforeId <= 0) fail('before_id must be a positive integer for show');
        body.before_id = beforeId;
      }
      if (params.limit !== undefined) {
        const limit = Number(params.limit);
        if (!Number.isInteger(limit) || limit <= 0) fail('limit must be a positive integer for show');
        body.limit = limit;
      }
      break;
    }
    case 'member_status': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for member_status');
      body = { task_id: taskId };
      break;
    }
    case 'send': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for send');
      const content = String(params.content ?? '').trim();
      if (!content) fail('content is required for send');
      body = { task_id: taskId, content };
      const metabotName = String(params.metabot_name ?? '').trim();
      if (metabotName) body.metabot_name = metabotName;
      if (typeof params.metabot_id === 'number') body.metabot_id = params.metabot_id;
      const replyPin = String(params.reply_pin ?? '').trim();
      if (replyPin) body.reply_pin = replyPin;
      if (Array.isArray(params.mention) && params.mention.length) body.mention = params.mention;
      // P2 (v1.1): explicit escape hatch for a manual chair-identity send —
      // the server refuses chair sends without it (impersonation guard).
      if (params.confirm_chair === true) body.confirm_chair = true;
      const driverId = String(params.driver_id ?? '').trim();
      if (driverId) body.driver_id = driverId;
      break;
    }
    case 'invite': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for invite');
      const metabotName = String(params.metabot_name ?? '').trim();
      body = { task_id: taskId };
      if (typeof params.metabot_id === 'number' && params.metabot_id > 0) {
        body.metabot_id = params.metabot_id;
      } else if (metabotName) {
        body.metabot_name = metabotName;
      } else {
        fail('metabot_id or metabot_name is required for invite');
      }
      break;
    }
    case 'kick': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for kick');
      body = { task_id: taskId };
      const globalmetaid = String(params.globalmetaid ?? '').trim();
      const metabotName = String(params.metabot_name ?? '').trim();
      if (globalmetaid) {
        body.globalmetaid = globalmetaid;
      } else if (typeof params.metabot_id === 'number' && params.metabot_id > 0) {
        body.metabot_id = params.metabot_id;
      } else if (metabotName) {
        body.metabot_name = metabotName;
      } else {
        fail('globalmetaid, metabot_id or metabot_name is required for kick');
      }
      const reason = String(params.reason ?? '').trim();
      if (reason) body.reason = reason;
      break;
    }
    case 'search_candidates': {
      const query = String(params.query ?? '').trim();
      const roleHint = String(params.role_hint ?? '').trim();
      if (!query && !roleHint) fail('query or role_hint is required for search_candidates');
      body = {};
      if (query) body.query = query;
      if (roleHint) body.role_hint = roleHint;
      const domainLabel = String(params.domain_label ?? '').trim();
      if (domainLabel) body.domain_label = domainLabel;
      if (Array.isArray(params.skills) && params.skills.length) {
        body.skills = params.skills.map((item) => String(item ?? '').trim()).filter(Boolean);
      }
      if (params.limit !== undefined) {
        const limit = Number(params.limit);
        if (!Number.isInteger(limit) || limit <= 0) fail('limit must be a positive integer for search_candidates');
        body.limit = limit;
      }
      const staffingPreference = String(params.staffing_preference ?? '').trim();
      if (staffingPreference) {
        const allowed = ['fixed_team', 'previous_team', 'local_only'];
        if (!allowed.includes(staffingPreference)) {
          fail(`staffing_preference must be one of: ${allowed.join(', ')}`);
        }
        body.staffing_preference = staffingPreference;
      }
      break;
    }
    case 'search_remote': {
      body = {};
      const query = String(params.query ?? '').trim();
      const skill = String(params.skill ?? '').trim();
      if (query) body.query = query;
      if (skill) body.skill = skill;
      if (params.limit !== undefined) {
        const limit = Number(params.limit);
        if (!Number.isInteger(limit) || limit <= 0) fail('limit must be a positive integer for search_remote');
        body.limit = limit;
      }
      break;
    }
    case 'invite_remote': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for invite_remote');
      const globalmetaid = String(params.globalmetaid ?? '').trim();
      if (!globalmetaid) fail('globalmetaid is required for invite_remote');
      body = { task_id: taskId, globalmetaid };
      const name = String(params.name ?? '').trim();
      if (name) body.name = name;
      if (Array.isArray(params.required_skills) && params.required_skills.length) {
        body.required_skills = params.required_skills.map((s) => String(s ?? '').trim()).filter(Boolean);
      }
      if (params.allow_reinvite === true || params.allow_reinvite === 'true') {
        body.allow_reinvite = true;
      }
      break;
    }
    case 'close': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for close');
      const status = String(params.status ?? '').trim();
      if (status !== 'done' && status !== 'cancelled') fail("close status must be 'done' or 'cancelled'");
      body = { task_id: taskId, status };
      const reason = String(params.reason ?? '').trim();
      if (reason) body.reason = reason;
      break;
    }
    case 'supervise': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for supervise');
      const signal = String(params.signal ?? '').trim();
      if (signal !== 'nudge' && signal !== 'flag' && signal !== 'pause' && signal !== 'resume') {
        fail("supervise signal must be one of: 'nudge', 'flag', 'pause', 'resume'");
      }
      const note = String(params.note ?? '').trim();
      if (!note) fail('note is required for supervise (what to check / flag / why pause or resume)');
      if (signal === 'resume' && params.confirm_owner !== true) {
        fail("resume requires the owner's explicit confirmation — pass confirm_owner: true only after the owner confirms");
      }
      body = { task_id: taskId, signal, note };
      const target = String(params.target ?? '').trim();
      if (target) body.target = target;
      if (params.confirm_owner === true) body.confirm_owner = true;
      break;
    }
    case 'deliverable-delete': {
      const taskId = Number(params.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) fail('task_id is required for deliverable-delete');
      const deliverableId = Number(params.deliverable_id);
      if (!Number.isInteger(deliverableId) || deliverableId <= 0) fail('deliverable_id is required for deliverable-delete');
      body = { task_id: taskId, deliverable_id: deliverableId };
      break;
    }
    default:
      fail(`unsupported action: ${action}`);
  }

  const result = await postJson(path, body);

  if (action === 'bots') {
    const metabots = Array.isArray(result.metabots) ? result.metabots : [];
    if (metabots.length === 0) {
      console.log('(no local MetaBots)');
      return;
    }
    for (const bot of metabots) {
      const headline = [bot.role, bot.bio].filter(Boolean).join(' — ');
      const status = bot.enabled ? 'enabled' : 'disabled';
      console.log(`- ${bot.name} [${bot.metabot_type}] ${status} (id=${bot.id})`);
      if (headline) console.log(`  ${headline}`);
      if (bot.goal) console.log(`  Goal: ${bot.goal}`);
    }
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
