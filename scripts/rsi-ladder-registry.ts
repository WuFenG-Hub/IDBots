/**
 * RSI 爬梯卡登记三步（§1.4 执行语义）的人工触发 CLI —— 只工具化「查重」与
 * 「回执」两步；「写入」永远由落地方自己 post_simplelog 上链（§5.3 不自动执行）。
 *
 * 用法：
 *   npm run rsi-ladder:dedup  -- --improvement-id <64hex 或 64hex+i0> [--data-dir <path>]
 *   npm run rsi-ladder:receipt -- --registered-pin <64hex+i0> --improvement-id <…>
 *        --initiator owner|bot --time <ISO8601> [--initiator-id <globalMetaId>]
 *        [--reason <发起理由摘要>] [--data-dir <path>]
 *
 * dedup 数据源：链上登记链（manapi pins_by_path → taskkey=local:88）+ 本机登记索引。
 * 查重命中时退出码 2（供人工/脚本门禁），干净时退出码 0。
 * 回执在查重干净后才追加一行 JSONL；重复触发只落一条（幂等第一层镜像）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendReceipt,
  readReceipts,
  registrationIndexPathFor,
} from '../src/main/services/rsiLadderIndex';
import { buildModels } from '../src/main/services/rsiLadderCompute';
import { RSI_LADDER_TASKKEY } from '../src/renderer/types/rsiLadder';

const MANAPI_BASE = 'https://manapi.metaid.io';
const IMPROVEMENT_ID_RE = /^(?:[0-9a-f]{64}|[0-9a-f]{64}i0)$/;
const PINID_RE = /^[0-9a-f]{64}i0$/;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args[key] = value;
      if (value !== 'true') i += 1;
    }
  }
  return args;
}

function resolveDataDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.IDBOTS_USER_DATA_PATH) return process.env.IDBOTS_USER_DATA_PATH;
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'IDBots');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'IDBots');
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'IDBots');
  }
}

interface ManapiPinItem {
  id?: unknown;
  timestamp?: unknown;
  contentSummary?: unknown;
}

interface ManapiResponse {
  data?: { list?: ManapiPinItem[]; nextCursor?: unknown };
}

async function fetchJson(url: string): Promise<ManapiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return JSON.parse(await response.text()) as ManapiResponse;
  } finally {
    clearTimeout(timer);
  }
}

interface ChainHit {
  pinId: string;
  improvementId: string;
  createdAtMs: number;
}

/** 链上分支查重：抓 /protocols/simplelog，按 taskkey=local:88 解析出登记 improvement_id。 */
/** 防御性扫描上限：与视图服务 MAX_PAGES 同一裁决（全量回填，5000 条防御帽）。 */
const MAX_SCAN_PAGES = 50;

async function fetchChainHits(): Promise<ChainHit[]> {
  const hits: ChainHit[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const url = new URL('api/pin/path/list', `${MANAPI_BASE}/`);
    url.searchParams.set('path', '/protocols/simplelog');
    url.searchParams.set('size', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchJson(url.toString());
    const list: ManapiPinItem[] = response?.data?.list ?? [];
    for (const item of list) {
      const pinId = typeof item?.id === 'string' ? item.id : '';
      const summaryText = typeof item?.contentSummary === 'string' ? item.contentSummary : '';
      let payload: Record<string, unknown> | null = null;
      if (summaryText.trim().startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(summaryText);
          payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          payload = null;
        }
      }
      if (!payload) continue;
      if (payload.taskkey !== RSI_LADDER_TASKKEY) continue;
      const { registrations } = buildModels([
        {
          pinId,
          createdAtMs: typeof item?.timestamp === 'number' ? item.timestamp * 1000 : 0,
          source: 'chain',
          payload,
        },
      ]);
      for (const registration of registrations) {
        hits.push({ pinId, improvementId: registration.improvementId, createdAtMs: registration.createdAtMs });
      }
    }
    const next = response?.data?.nextCursor;
    if (typeof next !== 'string' || !next || list.length === 0) break;
    cursor = next;
    if (page === MAX_SCAN_PAGES - 1) truncated = true;
  }
  if (truncated) {
    console.error('[rsi-ladder] 警告：链上扫描达到防御性上限（50 页/5000 条）仍有余页，查重结果可能不完整——请人工复核或提高上限');
  }
  return hits;
}

/** 子命令判定（互斥分发；无/未知子命令一律 fail-closed，杜绝静默串命令）。 */
export type RegistryCommand = 'dedup' | 'receipt';

export function resolveCommand(argv: string[]): RegistryCommand | null {
  const positional = argv.find((token) => !token.startsWith('--'));
  return positional === 'dedup' || positional === 'receipt' ? positional : null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = resolveCommand(process.argv.slice(2));
  const dataDir = resolveDataDir(args['data-dir']);
  const indexPath = registrationIndexPathFor(dataDir);

  if (command === 'dedup') {
    const improvementId = args['improvement-id'] ?? '';
    if (!IMPROVEMENT_ID_RE.test(improvementId)) {
      console.error(`[rsi-ladder] improvement-id 不合法（需全量 64hex 或 64hex+i0）：${improvementId}`);
      return 1;
    }
    const indexHit = readReceipts(indexPath).receipts.some((r) => r.improvementId === improvementId);
    let chainHits: ChainHit[] = [];
    let chainError: string | null = null;
    try {
      chainHits = await fetchChainHits();
    } catch (error) {
      chainError = error instanceof Error ? error.message : String(error);
    }
    const chainMatched = chainHits.filter((hit) => hit.improvementId === improvementId);
    console.log(`[rsi-ladder] dedup improvement_id=${improvementId}`);
    console.log(`  索引(${indexPath})：${indexHit ? '命中' : '未命中'}`);
    if (chainError) {
      console.log(`  链上：读取失败（${chainError}）——按执行语义，链上不可达时写入步应由人工再查一次`);
    } else if (chainMatched.length > 0) {
      for (const hit of chainMatched) console.log(`  链上：命中 pin ${hit.pinId}`);
    } else {
      console.log(`  链上：未命中（扫描 ${chainHits.length} 条 local:88 记录）`);
    }
    if (indexHit || chainMatched.length > 0) {
      console.log('[rsi-ladder] 结果：已存在登记 → 本次不写（幂等第一层，§1.4 步骤1）');
      return 2;
    }
    if (chainError) return 3;
    console.log('[rsi-ladder] 结果：双源未命中 → 可执行写入步（手动 post_simplelog）');
    return 0;
  }

  if (command === 'receipt') {
    const registeredPin = args['registered-pin'] ?? '';
    const improvementId = args['improvement-id'] ?? '';
    const initiator = args.initiator === 'owner' ? 'owner' : args.initiator === 'bot' ? 'bot' : null;
    const time = args.time ?? '';
    if (!PINID_RE.test(registeredPin)) {
      console.error(`[rsi-ladder] registered-pin 不合法（需 64hex+i0）：${registeredPin}`);
      return 1;
    }
    if (!IMPROVEMENT_ID_RE.test(improvementId)) {
      console.error(`[rsi-ladder] improvement-id 不合法：${improvementId}`);
      return 1;
    }
    if (!initiator) {
      console.error('[rsi-ladder] initiator 必须是 owner|bot');
      return 1;
    }
    if (!Number.isFinite(Date.parse(time))) {
      console.error(`[rsi-ladder] time 必须是 ISO8601：${time}`);
      return 1;
    }
    // 回执前再跑一次链上查重：写入步与回执步之间链上可能出现同 id 登记。
    try {
      const chainHits = await fetchChainHits();
      const chainMatched = chainHits.filter(
        (hit) => hit.improvementId === improvementId && hit.pinId !== registeredPin,
      );
      if (chainMatched.length > 0) {
        console.error(`[rsi-ladder] 链上已存在同 improvement_id 的其他登记（pin ${chainMatched[0].pinId}）→ 拒绝回执`);
        return 2;
      }
    } catch (error) {
      console.error(`[rsi-ladder] 链上查重失败（${error instanceof Error ? error.message : error}）→ 拒绝回执，请稍后重试`);
      return 3;
    }
    const outcome = appendReceipt(indexPath, {
      registeredPin,
      improvementId,
      initiator,
      initiatorId: args['initiator-id'] ?? '',
      time,
      reasonSummary: args.reason,
    });
    if (!outcome.ok) {
      console.error(`[rsi-ladder] 回执被拒：${outcome.reason === 'duplicate' ? '索引中已登记（幂等）' : outcome.detail}`);
      return 2;
    }
    console.log(`[rsi-ladder] 回执已追加：${indexPath}`);
    console.log(`  ${JSON.stringify(outcome.receipt)}`);
    return 0;
  }

  console.error('用法：rsi-ladder-registry.ts <dedup|receipt> [--参数见文件头注释]');
  return 1;
}

// 仅直接执行时运行（被测试 import 时不产生副作用——P1 修复的可测性前提）。
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('[rsi-ladder] 未捕获错误：', error);
      process.exit(1);
    });
}
