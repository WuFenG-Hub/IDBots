/**
 * OPCAT network MetaID PIN (inscribe) logic. Used by createPinWorker when network is 'opcat'.
 * Ported from open-agent-connect src/core/chain/adapters/opcat.ts (buildInscription flow).
 * OPCAT uses a single OP_RETURN transaction with a non-standard SIGHASH algorithm
 * (spentDataHash / hashSpentDataHashes fields), so transaction building and signing
 * use @opcat-labs/scrypt-ts-opcat instead of standard bitcoinjs-lib.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOpcat = any;

const OPCAT_WALLET_API = 'https://wallet-api.opcatlabs.io';
const OPCAT_DUST_LIMIT = 1;
const DEFAULT_OPCAT_FEE_RATE = 0.001;
const MAX_CHUNK_LEN = 240;
const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[opcat-inscribe] ${msg}\n`);
  } catch { /* noop */ }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toFiniteNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

let _opcatLib: AnyOpcat | null = null;

async function getOpcatLib(): Promise<AnyOpcat> {
  if (!_opcatLib) {
    // The package uses Object.defineProperty getters for exports, so type
    // inference is unreliable; cast at the integration boundary.
    _opcatLib = await import('@opcat-labs/scrypt-ts-opcat');
  }
  return _opcatLib;
}

async function opcatV5Get<T>(path: string): Promise<T> {
  const url = `${OPCAT_WALLET_API}/v5${path}`;
  const response = await fetch(url);
  const json = (await response.json()) as { code?: number; msg?: string; data?: T };
  if (json?.code !== 0) {
    throw new Error(json?.msg || 'OPCAT API error');
  }
  return json.data as T;
}

async function computeOpcatTxId(rawTx: string): Promise<string> {
  const opcat = await getOpcatLib();
  try {
    const tx = (opcat.Transaction as AnyOpcat).fromString(rawTx);
    return String(tx.hash || '');
  } catch {
    return '';
  }
}

async function opcatBroadcastTx(rawTx: string): Promise<string> {
  const response = await fetch(`${OPCAT_WALLET_API}/v5/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawtx: rawTx }),
  });
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    if (json?.code !== 0 && json?.code != null) {
      throw new Error(json?.msg || 'OPCAT broadcast failed');
    }
    const txid = normalizeText(json?.data ?? json?.msg ?? '');
    if (txid && txid.length >= 10) return txid;
  } catch (err) {
    if (err instanceof SyntaxError) {
      const txid = normalizeText(text);
      if (txid && txid.length >= 10) return txid;
    } else {
      throw err;
    }
  }
  const hash = await computeOpcatTxId(rawTx);
  if (hash && hash.length >= 10) return hash;
  throw new Error('OPCAT broadcast returned an invalid txid.');
}

async function deriveOpcatPrivateKey(
  mnemonic: string,
  path: string,
): Promise<{ privateKey: AnyOpcat; address: string }> {
  const opcat = await getOpcatLib();
  const mnemonicObj = new opcat.Mnemonic(mnemonic);
  const hdPriv: AnyOpcat = mnemonicObj.toHDPrivateKey();
  const derived: AnyOpcat = hdPriv.deriveChild(path);
  const pk = derived.privateKey;
  const address: string = pk.toAddress().toString();
  if (!address) {
    throw new Error('OPCAT address derivation failed.');
  }
  return { privateKey: pk, address };
}

/** BIP62 push-data encoding (used for MetaID inscription payloads). */
function pushData(data: Buffer): Buffer {
  const len = data.length;
  if (len === 0) {
    return Buffer.from([OP_0]);
  }
  if (len < 76) {
    return Buffer.concat([Buffer.from([len]), data]);
  }
  if (len <= 0xff) {
    return Buffer.concat([Buffer.from([OP_PUSHDATA1, len]), data]);
  }
  if (len <= 0xffff) {
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(len);
    return Buffer.concat([Buffer.from([OP_PUSHDATA2]), lenBuf, data]);
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(len);
  return Buffer.concat([Buffer.from([OP_PUSHDATA4]), lenBuf, data]);
}

function buildMetaIdInscriptionPayload(request: {
  operation: string;
  path: string;
  contentType: string;
  encryption: string;
  version: string;
  body: Buffer;
}): Buffer {
  const bodyParts: Buffer[] = [];
  for (let i = 0; i < request.body.length; i += MAX_CHUNK_LEN) {
    bodyParts.push(request.body.slice(i, Math.min(i + MAX_CHUNK_LEN, request.body.length)));
  }
  if (bodyParts.length === 0) bodyParts.push(Buffer.alloc(0));

  const chunks: Buffer[] = [];
  chunks.push(pushData(Buffer.from('metaid')));
  chunks.push(pushData(Buffer.from(request.operation)));
  chunks.push(pushData(Buffer.from(request.path || '')));
  chunks.push(pushData(Buffer.from(request.encryption || '0')));
  chunks.push(pushData(Buffer.from(request.version || '0.0.1')));
  chunks.push(pushData(Buffer.from(request.contentType || 'text/plain')));
  for (const part of bodyParts) chunks.push(pushData(part));
  return Buffer.concat(chunks);
}

function estimateTxSize(p2pkhInputCount: number, outputCount: number): number {
  let size = 10; // version + locktime + varints
  size += p2pkhInputCount * 148; // each P2PKH input ~148 bytes
  size += outputCount * 34; // each P2PKH output ~34 bytes
  return size;
}

function selectUtxos(
  availableUtxos: Array<{
    txId: string;
    outputIndex: number;
    satoshis: number;
    address: string;
    height: number;
    scriptPk: string;
  }>,
  targetAmount: number,
  feeRate: number,
  outputCount: number,
): {
  selectedUtxos: Array<{
    txId: string;
    outputIndex: number;
    satoshis: number;
    address: string;
    height: number;
    scriptPk: string;
  }>;
  fee: number;
  totalInput: number;
} {
  const sortedUtxos = [...availableUtxos].sort((a, b) => b.satoshis - a.satoshis);
  const selectedUtxos: Array<(typeof availableUtxos)[number]> = [];
  let totalInput = 0;
  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.satoshis;
    const txSize = estimateTxSize(selectedUtxos.length, outputCount);
    const fee = Math.ceil(txSize * feeRate);
    if (totalInput >= targetAmount + fee) {
      return { selectedUtxos, fee, totalInput };
    }
  }
  throw new Error(`Insufficient funds: need ${targetAmount}, have ${totalInput}`);
}

async function fetchOpcatUtxos(address: string): Promise<
  Array<{
    txId: string;
    outputIndex: number;
    satoshis: number;
    address: string;
    height: number;
    scriptPk: string;
  }>
> {
  const data = await opcatV5Get<
    Array<{ txid: string; vout: number; satoshis: number; scriptPk: string; height?: number }>
  >(`/address/btc-utxo?address=${encodeURIComponent(address)}`);
  const list = Array.isArray(data) ? data : [];
  const utxos = list
    .filter((item) => toFiniteNumber(item.satoshis) >= OPCAT_DUST_LIMIT)
    .map((item) => ({
      txId: normalizeText(item.txid),
      outputIndex: Number(item.vout),
      satoshis: toFiniteNumber(item.satoshis),
      address,
      height: Number(item.height ?? 0),
      scriptPk: normalizeText(item.scriptPk),
    }));
  const confirmed = utxos.filter((u) => u.height > 0);
  const unconfirmed = utxos.filter((u) => u.height <= 0);
  return [...confirmed, ...unconfirmed];
}

async function fetchOpcatFeeRate(): Promise<number> {
  try {
    const data = await opcatV5Get<{ list?: Array<{ title?: string; feeRate?: number }> }>(
      '/default/fee-summary',
    );
    const list = data?.list ?? [];
    const fastest = list.find((t) => t.title === 'Fastest');
    if (fastest && toFiniteNumber(fastest.feeRate) > 0) {
      return toFiniteNumber(fastest.feeRate);
    }
    const firstRate = toFiniteNumber(list[0]?.feeRate);
    return firstRate > 0 ? firstRate : DEFAULT_OPCAT_FEE_RATE;
  } catch {
    return DEFAULT_OPCAT_FEE_RATE;
  }
}

export interface OpcatMetaidData {
  operation: string;
  path?: string;
  encryption?: string;
  version?: string;
  contentType?: string;
  payload: string;
  encoding?: 'utf-8' | 'base64';
}

export async function runOpcatCreatePin(
  mnemonic: string,
  pathStr: string,
  metaidData: OpcatMetaidData,
  feeRate: number,
): Promise<{ success: boolean; txids: string[]; pinId: string; totalCost: number; error?: string }> {
  const opcat = await getOpcatLib();
  const encoding = metaidData.encoding === 'base64' ? 'base64' : 'utf-8';
  const body = Buffer.from(metaidData.payload, encoding);

  const { privateKey, address } = await deriveOpcatPrivateKey(mnemonic, pathStr);
  debugLog(`address=${address}`);

  const resolvedFeeRate = Number.isFinite(feeRate) && feeRate > 0 ? feeRate : await fetchOpcatFeeRate();
  debugLog(`feeRate=${resolvedFeeRate} sat/byte`);

  const utxos = await fetchOpcatUtxos(address);
  if (!utxos.length) {
    throw new Error('MetaBot OPCAT balance is insufficient for this chain write.');
  }

  const inscriptionPayload = buildMetaIdInscriptionPayload({
    operation: metaidData.operation,
    path: metaidData.path || '',
    contentType: metaidData.contentType || 'application/octet-stream',
    encryption: metaidData.encryption || '0',
    version: metaidData.version || '1.0',
    body,
  });

  const outputCount = 2; // OP_RETURN + change
  const { selectedUtxos, fee } = selectUtxos(utxos, 0, resolvedFeeRate, outputCount);
  debugLog(`selectedUtxoCount=${selectedUtxos.length} fee=${fee}`);

  const tx = new opcat.Transaction();
  for (const utxo of selectedUtxos) {
    tx.addInput(
      new (opcat.Transaction.Input.PublicKeyHash as new (...args: unknown[]) => unknown)({
        prevTxId: utxo.txId,
        outputIndex: utxo.outputIndex,
        script: (opcat.Script as AnyOpcat).empty(),
        output: new (opcat.Transaction.Output as new (...args: unknown[]) => unknown)({
          script: (opcat.Script as AnyOpcat).fromHex(utxo.scriptPk),
          satoshis: utxo.satoshis,
        }),
      }),
    );
  }
  tx.addData(inscriptionPayload);
  tx.change(address);
  tx.sign(privateKey as AnyOpcat);

  const rawTx: string = tx.uncheckedSerialize();
  try {
    const parsed = (opcat.Transaction as AnyOpcat).fromString(rawTx);
    debugLog(`validation OK — tx hash: ${parsed.hash}`);
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`OPCAT createPin produced invalid rawTx: ${message}`);
  }

  const txid = await opcatBroadcastTx(rawTx);
  debugLog(`broadcast ok txid=${txid}`);

  const pinId = txid ? `${txid}i0` : '';
  return { success: true, txids: [txid], pinId, totalCost: fee };
}
