// 记法与局面序列化 —— 纯逻辑，不依赖 DOM / Three.js
// 依据 docs/00-overview-and-game-protocol.md §4.3
//
// 引擎坐标: row 0..9 (0 = 黑方底线, 9 = 红方底线), col 0..8 (0 = 红方视角最左)
// ICCS 记法: file 'a'..'i' = col 0..8, rank = 9 - row (0 = 红方底线)
// FEN (UCCI 惯例): 从 row 0 到 row 9 逐行, 大写=红, 末尾 'w'=红方行棋 / 'b'=黑方行棋

import { RED, BLACK, ROWS, COLS, GLYPH, pieceAt, legalMoves } from './rules.js';

export const INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

const FEN_LETTER = {
  general: 'k', advisor: 'a', elephant: 'b', horse: 'n',
  chariot: 'r', cannon: 'c', soldier: 'p',
};

// ---- ICCS <-> 引擎坐标 ----

export function squareToIccs(row, col) {
  return String.fromCharCode(97 + col) + String(9 - row);
}

export function iccsToSquare(sq) {
  if (typeof sq !== 'string' || sq.length !== 2) return null;
  const col = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 48;
  if (col < 0 || col >= COLS || rank < 0 || rank >= ROWS) return null;
  return { row: 9 - rank, col };
}

export function moveToIccs(from, to) {
  return squareToIccs(from.row, from.col) + squareToIccs(to.row, to.col);
}

// 返回 { from: {row,col}, to: {row,col} } 或 null
export function iccsToMove(mv) {
  if (typeof mv !== 'string' || mv.length !== 4) return null;
  const from = iccsToSquare(mv.slice(0, 2));
  const to = iccsToSquare(mv.slice(2, 4));
  if (!from || !to) return null;
  return { from, to };
}

// ---- FEN ----

export function fenFromState(state) {
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    let empty = 0;
    for (let c = 0; c < COLS; c++) {
      const p = pieceAt(state.pieces, r, c);
      if (!p) { empty++; continue; }
      if (empty) { line += empty; empty = 0; }
      const letter = FEN_LETTER[p.type];
      line += p.color === RED ? letter.toUpperCase() : letter;
    }
    if (empty) line += empty;
    rows.push(line);
  }
  return rows.join('/') + ' ' + (state.turn === RED ? 'w' : 'b');
}

// ---- 合法走法枚举（ICCS） ----

// 返回 [{ mv, piece, capture }]，piece/capture 为棋子对象（capture 可为 null）
export function listLegalMoves(state) {
  const res = [];
  for (const p of state.pieces) {
    if (p.color !== state.turn) continue;
    for (const m of legalMoves(state.pieces, p)) {
      res.push({
        mv: moveToIccs({ row: p.row, col: p.col }, m),
        piece: p,
        capture: pieceAt(state.pieces, m.row, m.col),
      });
    }
  }
  res.sort((a, b) => (a.mv < b.mv ? -1 : a.mv > b.mv ? 1 : 0));
  return res;
}

// ---- 局面文本化（prompt 用，informative） ----

export function boardToText(state) {
  const lines = ['   a  b  c  d  e  f  g  h  i'];
  for (let r = 0; r < ROWS; r++) {
    let line = String(9 - r) + ' ';
    for (let c = 0; c < COLS; c++) {
      const p = pieceAt(state.pieces, r, c);
      line += ' ' + (p ? GLYPH[p.color][p.type] : '·') + (p ? '' : ' ');
    }
    lines.push(line);
    if (r === 4) lines.push('   ~~~~~~~~ 楚河 汉界 ~~~~~~~~');
  }
  lines.push(`FEN: ${fenFromState(state)}`);
  lines.push(`轮到${state.turn === RED ? '红方' : '黑方'}行棋`);
  return lines.join('\n');
}

// 简版中文着法描述，如 "红炮 h2e2 (吃卒)"
export function describeMove(state, from, to) {
  const p = pieceAt(state.pieces, from.row, from.col);
  if (!p) return moveToIccs(from, to);
  const target = pieceAt(state.pieces, to.row, to.col);
  const side = p.color === RED ? '红' : '黑';
  const glyph = GLYPH[p.color][p.type];
  const eat = target ? `（吃${GLYPH[target.color][target.type]}）` : '';
  return `${side}${glyph} ${moveToIccs(from, to)}${eat}`;
}
