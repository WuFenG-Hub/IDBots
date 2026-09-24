// Agent-Game-v2 象棋 Adapter（ABI v1，见 docs/08）
// 复用 js/rules.js（规则引擎）与 js/notation.js（记法/局面文本）。
// 纯状态计算：不访问网络、文件、钱包或宿主桥。
//
// 事件输入形状：{ ...agent-game/1 信封, meta: { index, senderMetaId, timestamp } }
// 可选扩展：getSeat(state, agentId) —— 供 Runtime 判断本机是否已占座。

import {
  RED, BLACK, createInitialState, pieceAt, legalMoves, applyMove, gameStatus,
} from '../js/rules.js';
import { iccsToMove, fenFromState, listLegalMoves, boardToText } from '../js/notation.js';

export const GAME_ID = 'xiangqi';
export const RULES_VERSION = '1.0.0';
export const MAX_PLIES = 300;
export const MOVE_TIMEOUT_MS = 900_000;

const opponent = side => (side === RED ? BLACK : RED);

export function createMatch(config) {
  return initialState(config);
}

export function initialState(config = {}) {
  return {
    match: {
      gameId: config.gameId || GAME_ID,
      rulesHash: config.rulesHash || '',
      title: config.title || '',
      manifestUri: config.manifestUri || '',
    },
    seats: { red: null, black: null },
    board: createInitialState(),
    plies: 0,
    phase: 'waiting',           // waiting | playing | finished
    result: null,               // { winner: 'red'|'black'|null, reason }
    lastProgressTs: null,
    lastEventIndex: -1,
    invalidEvents: [],
    history: [],                // 已生效动作摘要，供观察/回放
  };
}

function senderSeat(state, metaId) {
  if (state.seats.red && state.seats.red.metaId === metaId) return RED;
  if (state.seats.black && state.seats.black.metaId === metaId) return BLACK;
  return null;
}

export function getSeat(state, agentId) {
  for (const [side, seat] of Object.entries(state.seats)) {
    if (seat && seat.metaId === agentId) return side;
  }
  return null;
}

function finish(state, winner, reason) {
  state.phase = 'finished';
  state.result = { winner, reason };
}

export function reduce(state, event) {
  const meta = event.meta || {};
  if (meta.index != null && meta.index <= state.lastEventIndex) return state;
  if (meta.index != null) state.lastEventIndex = meta.index;
  const sender = meta.senderMetaId || '';

  switch (event.type) {
    case 'match.created': {
      if (state.phase !== 'waiting') return state;
      if (state.match.rulesHash && state.match.rulesHash !== event.rulesHash) return state;
      state.match = {
        gameId: event.gameId || state.match.gameId,
        rulesHash: event.rulesHash || state.match.rulesHash,
        title: event.payload?.title || state.match.title,
        manifestUri: event.payload?.manifestUri || state.match.manifestUri,
      };
      return state;
    }

    case 'seat.claimed': {
      if (state.phase !== 'waiting') return state;
      if (senderSeat(state, sender)) return state;
      const seat = {
        metaId: sender,
        name: typeof event.payload?.name === 'string' ? event.payload.name.slice(0, 100) : '',
        model: typeof event.payload?.model === 'string' ? event.payload.model.slice(0, 100) : '',
        avatar: typeof event.payload?.avatar === 'string' ? event.payload.avatar.slice(0, 500) : '',
      };
      const role = event.payload?.requestedRole;
      if (role === RED && !state.seats.red) state.seats.red = seat;
      else if (role === BLACK && !state.seats.black) state.seats.black = seat;
      else if (!state.seats.red) state.seats.red = seat;
      else if (!state.seats.black) state.seats.black = seat;
      else return state; // 两座位已满
      if (state.seats.red && state.seats.black) {
        state.phase = 'playing';
        state.lastProgressTs = meta.timestamp ?? null;
      }
      return state;
    }

    // 信息性事件：不驱动状态（docs/07：match.finished 不能覆盖确定性结果）
    case 'match.ready':
    case 'match.finished':
    case 'chat':
      return state;

    case 'action': {
      if (state.phase !== 'playing') return state;
      const side = senderSeat(state, sender);
      if (!side || side !== state.board.turn) return state;
      if (event.actionSeq !== state.plies + 1) return state;
      const action = event.payload || {};
      const parsed = iccsToMove(action.move);
      const piece = parsed && pieceAt(state.board.pieces, parsed.from.row, parsed.from.col);
      const legal = piece && piece.color === side
        && legalMoves(state.board.pieces, piece)
          .some(m => m.row === parsed.to.row && m.col === parsed.to.col);
      if (!legal) {
        // 非法事件不改变有效状态，记录诊断（docs/07）
        state.invalidEvents.push({ type: 'illegal_action', index: meta.index, actionSeq: event.actionSeq, sender });
        return state;
      }
      const captured = applyMove(state.board, piece, parsed.to);
      state.plies += 1;
      state.lastProgressTs = meta.timestamp ?? state.lastProgressTs;
      state.history.push({
        seq: event.actionSeq,
        side,
        mv: action.move.toLowerCase(),
        note: typeof action.note === 'string' ? action.note.slice(0, 200) : '',
        captured: captured ? { type: captured.type, color: captured.color } : null,
        index: meta.index,
      });
      const status = gameStatus(state.board);
      if (status.over) finish(state, side, status.check ? 'checkmate' : 'stalemate');
      else if (state.plies >= MAX_PLIES) finish(state, null, 'move_limit');
      return state;
    }

    case 'resign': {
      if (state.phase !== 'playing') return state;
      const side = senderSeat(state, sender);
      if (!side) return state;
      finish(state, opponent(side), 'resign');
      return state;
    }

    case 'timeout.claimed': {
      if (state.phase !== 'playing') return state;
      const side = senderSeat(state, sender);
      if (!side || side === state.board.turn) return state;
      if (state.lastProgressTs == null) return state;
      if ((meta.timestamp ?? 0) - state.lastProgressTs <= MOVE_TIMEOUT_MS) return state;
      finish(state, side, 'timeout');
      return state;
    }

    default:
      return state;
  }
}

export function getTurn(state) {
  if (state.phase === 'finished') return { phase: 'finished', seat: null, actionSeq: state.plies + 1 };
  if (state.phase === 'waiting') return { phase: 'waiting', seat: null, actionSeq: 0 };
  return { phase: 'playing', seat: state.board.turn, actionSeq: state.plies + 1 };
}

export function getObservation(state, seat) {
  return {
    gameId: state.match.gameId,
    phase: state.phase,
    seat,
    turn: state.board.turn,
    plies: state.plies,
    fen: fenFromState(state.board),
    board: boardToText(state.board),
    legalMoves: listLegalMoves(state.board).map(x => x.mv),
    recentMoves: state.history.slice(-8).map(h => `${h.side === RED ? '红' : '黑'} ${h.mv}`),
    result: state.result,
  };
}

export function getActionSchema(state) {
  return {
    format: 'json',
    example: '{"mv":"h2e2","note":"短解说"}',
    legalMoves: listLegalMoves(state.board).map(x => x.mv),
    note: '必须从 legalMoves 中选择一项，只输出该 JSON，不要输出其他文字。',
  };
}

export function parseAction(llmText, context = {}) {
  if (typeof llmText !== 'string' || !llmText.trim()) return { error: '输出为空' };
  const legal = new Set((context.schema && context.schema.legalMoves) || []);
  const candidates = llmText.match(/\{[^{}]*\}/g) || [];
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.mv === 'string') {
        const mv = obj.mv.trim().toLowerCase();
        if (legal.has(mv)) {
          return { action: { move: mv, note: typeof obj.note === 'string' ? obj.note.slice(0, 200) : '' } };
        }
        return { error: `走法 ${mv} 不在合法走法清单中` };
      }
    } catch { /* 尝试下一个候选 */ }
  }
  const iccs = llmText.match(/\b[a-i][0-9][a-i][0-9]\b/gi) || [];
  for (const raw of iccs) {
    const mv = raw.toLowerCase();
    if (legal.has(mv)) return { action: { move: mv, note: '' } };
  }
  return { error: '未能从输出中解析出合法走法' };
}

export function validateAction(state, action) {
  const mv = typeof action?.move === 'string' ? action.move : action?.mv;
  if (typeof mv !== 'string') {
    return { valid: false, ok: false, code: 'invalid_action', message: '缺少 move 字段' };
  }
  const parsed = iccsToMove(mv);
  const piece = parsed && pieceAt(state.board.pieces, parsed.from.row, parsed.from.col);
  const legal = piece && piece.color === state.board.turn
    && legalMoves(state.board.pieces, piece)
      .some(m => m.row === parsed.to.row && m.col === parsed.to.col);
  if (!legal) {
    return { valid: false, ok: false, code: 'illegal_action', message: `${mv} 不合法` };
  }
  return {
    valid: true,
    ok: true,
    normalizedAction: {
      move: mv.toLowerCase(),
      note: typeof action.note === 'string' ? action.note.slice(0, 200) : '',
    },
  };
}

export function serializeState(state) {
  // 宿主契约（IDBots agentGame/abi.ts）：serializeState 返回规范化字符串，
  // 供 stateHash 直接使用（固定键序保证确定性）。
  return JSON.stringify({
    phase: state.phase,
    match: state.match,
    seats: {
      red: state.seats.red
        ? { metaId: state.seats.red.metaId, name: state.seats.red.name, model: state.seats.red.model, avatar: state.seats.red.avatar }
        : null,
      black: state.seats.black
        ? { metaId: state.seats.black.metaId, name: state.seats.black.name, model: state.seats.black.model, avatar: state.seats.black.avatar }
        : null,
    },
    plies: state.plies,
    turn: state.board.turn,
    fen: fenFromState(state.board),
    result: state.result,
  });
}

export function getResult(state) {
  // 宿主契约（IDBots agentGame/abi.ts MatchResult）：finished:boolean；
  // status 为 v1 兼容别名，reason 保留给链上重放客户端。
  if (state.phase !== 'finished') return { finished: false, status: 'playing' };
  return {
    finished: true,
    winner: state.result.winner,
    reason: state.result.reason,
    status: 'finished',
  };
}
