#!/usr/bin/env node
/**
 * cerebellum-conversation-rank-eval — keyword order vs cerebellum re-rank.
 *
 * Hits are newest-first (the store's updated_at order). Relevant chats sit
 * later in that list. Metric: recall@1 (the first rendered chat).
 *
 *   node scripts/cerebellum-conversation-rank-eval.mjs eval --dry-run
 *   node scripts/cerebellum-conversation-rank-eval.mjs eval
 */

import { argv, env, exit } from 'node:process';
import {
  buildConversationRankRequest,
  orderConversationHits,
  parseConversationRankAnswers,
  rankConversationsWithCerebellum,
} from '../src/main/cerebellum/conversationSearchRank.ts';

const CHATS = [
  { id: 'c0', text: 'Title: 周报\nHuman: 这周数据用表格\nAssistant: 好，我按表格整理。' },
  { id: 'c1', text: 'Title: 晚饭\nHuman: 今晚吃火锅\nAssistant: 记得避开花生。' },
  { id: 'c2', text: 'Title: 链上交付\nHuman: 没有 txid 的交付会被打回\nAssistant: 以后每条交付都附 txid。' },
  { id: 'c3', text: 'Title: 小猫\nHuman: 布丁要低敏猫粮\nAssistant: 记下了。' },
  { id: 'c4', text: 'Title: worktree\nHuman: git status 全是修改是因为 exFAT\nAssistant: 把 core.filemode 设成 false。' },
];

const QUERIES = [
  { q: '上次说交付必须带什么', relevant: 'c2' },
  { q: '布丁吃什么粮', relevant: 'c3' },
  { q: '新建 worktree 之后文件全变修改了', relevant: 'c4' },
  { q: '周报里的数据怎么排', relevant: 'c0' },
];

function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg.startsWith('--')) { console.error(`unknown option: ${arg}`); exit(2); }
    else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? 'jev-latest';
if (mode !== 'eval') exit(2);

if (opts.dryRun) {
  console.log(`dry-run: ${CHATS.length} chats, ${QUERIES.length} queries — no API calls.\n`);
  console.log(JSON.stringify(buildConversationRankRequest({
    searchQuery: QUERIES[0].q,
    chats: CHATS,
    model,
  }), null, 2));
  process.exit(0);
}
if (!apiKey) {
  console.error('missing API key');
  exit(2);
}

const config = { provider: 'typesafe-jev', apiKey, baseUrl, model };
let recencyHits = 0;
let rankedHits = 0;
for (const item of QUERIES) {
  const scores = await rankConversationsWithCerebellum({
    config,
    fetchImpl: async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, json: () => res.json() };
    },
    searchQuery: item.q,
    chats: CHATS,
    timeoutMs: 30000,
  });
  const recencyFirst = CHATS[0].id;
  const ranked = scores ? orderConversationHits(CHATS, scores) : null;
  if (recencyFirst === item.relevant) recencyHits += 1;
  if (ranked && ranked[0].id === item.relevant) rankedHits += 1;
  console.log(`${item.q}\n  recency=${recencyFirst}  ranked=${ranked ? ranked[0].id : 'null'}  want=${item.relevant}`);
  if (!scores) {
    console.log('  (no verdict; parse check)', parseConversationRankAnswers(null, CHATS));
  }
}
console.log(`recall@1 recency ${recencyHits}/${QUERIES.length}  cerebellum ${rankedHits}/${QUERIES.length}`);
