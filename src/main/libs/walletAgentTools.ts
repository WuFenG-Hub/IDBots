import { z } from 'zod';
import type {
  ExternalTransferInfo,
  WalletMvcTransferParams,
  WalletTransferResult,
} from '../services/walletTransferService';
import type {
  MetabotWalletBalanceEntry,
  WalletBalanceQueryResult,
  WalletBalanceSnapshot,
  WalletQueryChain,
} from '../services/walletQueryService';

/**
 * Host control surface for the wallet tools, wired in main.ts: UTXO-sum
 * balance snapshots (R1) and two-channel MVC transfers with the audit ledger
 * (R2). `transfer` accepts a session-scoped owner-confirmation callback so
 * the channel-B gate renders the host's approval dialog.
 */
export type WalletToolsControl = {
  getBalances(input: { metabotIds?: number[]; chains?: WalletQueryChain[] }): Promise<WalletBalanceQueryResult>;
  getBalanceForAddress(chain: WalletQueryChain, address: string): Promise<WalletBalanceSnapshot>;
  resolveMetabotIdByName(name: string): number | null;
  getMetabotMvcAddress(metabotId: number): string | null;
  transfer(
    params: WalletMvcTransferParams,
    host?: { confirmExternal?: (info: ExternalTransferInfo) => Promise<boolean> },
  ): Promise<WalletTransferResult>;
  listTransfers(limit?: number, metabotId?: number): unknown[];
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const SATOSHI_PER_UNIT = 100_000_000;

function formatSnapshot(snapshot: WalletBalanceSnapshot): string {
  const total = (snapshot.total_sats / SATOSHI_PER_UNIT).toFixed(8);
  return (
    `- ${snapshot.chain}: confirmed ${snapshot.confirmed_sats} sats / unconfirmed ${snapshot.unconfirmed_sats} sats / ` +
    `total ${snapshot.total_sats} sats (${total} ${snapshot.unit}), ${snapshot.utxo_count} UTXOs`
  );
}

function formatBalanceEntry(entry: MetabotWalletBalanceEntry): string {
  const lines: string[] = [`# ${entry.name} (metabot_id ${entry.metabot_id})`];
  for (const chain of ['mvc', 'btc', 'doge'] as WalletQueryChain[]) {
    const snapshot = entry.balances[chain];
    if (snapshot) lines.push(formatSnapshot(snapshot));
    const error = entry.errors[chain];
    if (error) lines.push(`- ${chain}: lookup failed: ${error}`);
  }
  return lines.join('\n');
}

function looksLikeMvcAddress(value: string): boolean {
  // MVC/SPACE livenet addresses are base58 (start with 1, 20+ chars).
  return /^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value);
}

function formatTransferSuccess(result: WalletTransferResult & { success: true }): string {
  const lines: string[] = ['Transfer broadcast on-chain.'];
  lines.push(`- txid: ${result.txid}`);
  lines.push(`- fee (estimated): ${result.fee_sats} sats`);
  lines.push(`- channel: ${result.channel}${result.channel === 'local' ? ' (local roster, no confirmation required)' : ' (external, owner-confirmed)'}`);
  if (result.to_metabot_id != null) lines.push(`- to metabot_id: ${result.to_metabot_id}`);
  lines.push(`- audit record id: ${result.audit_id}`);
  return lines.join('\n');
}

function formatTransferFailure(result: WalletTransferResult & { success: false }): string {
  const lines = [`Transfer failed (${result.error_code}): ${result.error}`];
  if (result.have_sats != null) lines.push(`- have: ${result.have_sats} sats (${(result.have_sats / SATOSHI_PER_UNIT).toFixed(8)} SPACE)`);
  if (result.need_sats != null) lines.push(`- need: ${result.need_sats} sats (${(result.need_sats / SATOSHI_PER_UNIT).toFixed(8)} SPACE, amount + estimated fee)`);
  return lines.join('\n');
}

/**
 * wallet_balance (R1) and wallet_transfer (R2) inline MCP tools for every
 * cowork surface. Balance queries are read-only (public chain data) and
 * batch over the LOCAL metabot roster plus explicitly passed addresses.
 * Transfers always spend the session MetaBot's OWN wallet; local-roster
 * targets go straight through, external targets ask the owner unless the
 * gate is disabled in settings.
 */
export function buildWalletAgentTools(deps: {
  tool: SdkToolFactory;
  control: WalletToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  /** Renders the channel-B owner approval dialog; wired by coworkRunner. */
  confirmExternalTransfer?: (info: ExternalTransferInfo) => Promise<boolean>;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const walletBalance = tool(
    'wallet_balance',
    [
      'Query wallet balances (UTXO sums) for local MetaBots by id, name, or raw address, optionally per chain.',
      'Use when the user asks for a bot wallet balance, "全班余额一览", or before planning on-chain work that costs fees. Batch multiple metabot_ids in ONE call (add names for name-based lookup).',
      'Read-only public chain data: MVC/DOGE walk the Metalet utxo-list (flag pagination), BTC uses the v3 btc-utxo endpoint. Returns confirmed / unconfirmed / total in sats per chain plus the query time.',
      'Batch queries cover the LOCAL metabot roster plus explicitly passed addresses only.',
    ].join(' '),
    {
      metabot_ids: z
        .array(z.number().int().positive())
        .optional()
        .describe('Local MetaBot ids to query, e.g. [1, 15]. Batch in one call.'),
      names: z
        .array(z.string())
        .optional()
        .describe('Local MetaBot names to resolve and query, e.g. ["AI_Sunny", "Builder阿码"].'),
      address: z
        .string()
        .optional()
        .describe('Explicit address to query (chain-specific; used as-is).'),
      chain: z
        .enum(['mvc', 'btc', 'doge'])
        .optional()
        .describe('Limit to one chain; omit for all three.'),
    },
    async (args: {
      metabot_ids?: number[];
      names?: string[];
      address?: string;
      chain?: WalletQueryChain;
    }) => {
      const chains: WalletQueryChain[] | undefined = args.chain ? [args.chain] : undefined;
      const metabotIds: number[] = [];
      for (const raw of args.metabot_ids ?? []) {
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0 && !metabotIds.includes(id)) metabotIds.push(id);
      }
      for (const rawName of args.names ?? []) {
        const name = asString(rawName);
        if (!name) continue;
        const id = control.resolveMetabotIdByName(name);
        if (id == null) {
          return textResult(`wallet_balance: local MetaBot not found by name: ${name}`, true);
        }
        if (!metabotIds.includes(id)) metabotIds.push(id);
      }

      const sections: string[] = [];
      try {
        if (metabotIds.length > 0) {
          const result = await control.getBalances({ metabotIds, chains });
          sections.push(...result.entries.map(formatBalanceEntry));
        }
        const address = asString(args.address);
        if (address) {
          const list = chains ?? (['mvc', 'btc', 'doge'] as WalletQueryChain[]);
          for (const chain of list) {
            try {
              sections.push(formatSnapshot(await control.getBalanceForAddress(chain, address)));
            } catch (error) {
              sections.push(`- ${chain}: lookup failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        if (sections.length === 0) {
          return textResult(
            'wallet_balance requires metabot_ids, names, or address (pass the ids you want in ONE call).',
            true,
          );
        }
        return textResult(sections.join('\n'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_balance failed: ${msg}`, true);
      }
    }
  );

  const walletTransfer = tool(
    'wallet_transfer',
    [
      'Transfer SPACE (MVC native coin) from THIS session MetaBot\'s own wallet to a target address or local MetaBot.',
      'Use when the owner asks to top up / recharge a worker bot, move funds between local bots, or send SPACE. `to` accepts a local metabot_id, a local bot name, or a raw MVC address; `amount` is in SPACE.',
      'Channel A (target resolves to the local roster): executes immediately, no confirmation. Channel B (external address): asks the owner by default (from/to/amount/estimated fee), unless disabled in settings.',
      'Every attempt (broadcast, refused, failed) is recorded in the local transfer audit ledger. Insufficient balance fails fast with a structured have/need error. Signing stays inside the host; no key material is exposed.',
    ].join(' '),
    {
      to: z
        .string()
        .min(1)
        .describe('Target: local metabot_id (e.g. "15"), local bot name, or MVC address.'),
      amount: z
        .number()
        .positive()
        .describe('Amount in SPACE (e.g. 0.001). Dust limit applies (600 sats).'),
      memo: z.string().optional().describe('Optional note stored in the audit record.'),
    },
    async (args: { to: string; amount: number; memo?: string }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'wallet_transfer could not determine which MetaBot owns this session; transfers must spend the session bot\'s own wallet.',
          true,
        );
      }

      const toRaw = asString(args.to);
      if (!toRaw) {
        return textResult('wallet_transfer requires `to` (metabot_id, name, or address).', true);
      }
      // Resolve `to`: metabot id or local name → local mvc address; else raw address.
      let toAddress = '';
      let toMetabotId: number | null = null;
      if (/^\d+$/.test(toRaw)) {
        const id = Number(toRaw);
        const address = control.getMetabotMvcAddress(id);
        if (address) {
          toAddress = address;
          toMetabotId = id;
        } else {
          return textResult(`wallet_transfer: local MetaBot not found: ${toRaw}`, true);
        }
      } else if (!looksLikeMvcAddress(toRaw)) {
        const id = control.resolveMetabotIdByName(toRaw);
        if (id == null) {
          return textResult(
            `wallet_transfer: "${toRaw}" is neither a local MetaBot name nor an address. For an external address pass the full MVC address.`,
            true,
          );
        }
        toMetabotId = id;
        toAddress = control.getMetabotMvcAddress(id) ?? '';
        if (!toAddress) {
          return textResult(`wallet_transfer: MetaBot ${toRaw} has no mvc address.`, true);
        }
      } else {
        toAddress = toRaw;
      }

      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return textResult('wallet_transfer requires a positive `amount` in SPACE.', true);
      }
      const amountSats = Math.round(amount * SATOSHI_PER_UNIT);
      if (!Number.isInteger(amountSats) || amountSats < 600) {
        return textResult('wallet_transfer: amount below the MVC dust limit (600 sats).', true);
      }

      try {
        const result = await control.transfer(
          {
            metabotId,
            to: toAddress,
            amountSats,
            memo: asString(args.memo) || undefined,
            sessionId,
            origin: 'tool:wallet_transfer',
          },
          deps.confirmExternalTransfer ? { confirmExternal: deps.confirmExternalTransfer } : undefined,
        );
        // `=== true` (not bare truthiness): the project runs without
        // strictNullChecks, where boolean truthiness does not narrow the
        // discriminated union.
        return result.success === true
          ? textResult(formatTransferSuccess(result))
          : textResult(formatTransferFailure(result), true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`wallet_transfer failed: ${msg}`, true);
      }
    }
  );

  return [walletBalance, walletTransfer];
}
