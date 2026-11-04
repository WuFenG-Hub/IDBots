import type { MetabotStore } from '../metabotStore';
import {
  isAvatarNormalizeFailure,
  normalizeAvatarToDataUrl,
  type AvatarNormalizeResult,
} from '../utils/avatarNormalize';
import type {
  MetabotMrc721TransferInput,
  MetabotMvcNftTransferInput,
  MetabotNftKind,
  MetabotNftListItem,
} from './metabotNftService';

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

/** Result shape of the shared metabot update core (the metabot:update path). */
interface MetabotAvatarUpdateResult {
  success: boolean;
  metabot?: unknown;
  sync?: unknown;
  error?: string;
}

export interface MetabotSetNftAvatarInput {
  metabotId: number;
  /** `metafile://<pinId>[.ext]`, a bare pinId, or an https artwork URL (MetaContract). */
  imageRef: string;
}

export interface MetabotSetNftAvatarResult {
  success: boolean;
  metabot?: unknown;
  /**
   * Normalized snapshot facts. The chain info-pin only accepts a data URL
   * (`metaidCore.buildEditAvatarSyncStep`), so the avatar is stored as a
   * snapshot of the NFT artwork — the reference itself never reaches the chain.
   */
  avatar?: { mime: string; bytes: number; source: string };
  /** On-chain sync outcome of the avatar step (same shape as metabot:update). */
  sync?: unknown;
  /** Structured normalization failure reason when the artwork could not be used. */
  reason?: string;
  detail?: string;
  error?: string;
}

interface RegisterMetabotNftIpcHandlersDeps {
  registerIpcHandler: RegisterIpcHandlerFn;
  getMetabotStore: () => MetabotStore;
  getMetabotNftItems: (
    store: MetabotStore,
    input: { metabotId: number; kind: MetabotNftKind },
  ) => Promise<MetabotNftListItem[]>;
  transferMetabotMvcNft: (
    store: MetabotStore,
    input: MetabotMvcNftTransferInput,
  ) => Promise<{ txId: string; rawTx: string }>;
  transferMetabotMrc721: (
    store: MetabotStore,
    input: MetabotMrc721TransferInput,
  ) => Promise<{ txId: string; pinId: string; toAddress: string; spentOutpoint: string; outputValue: number }>;
  /** Avatar normalizer (defaults to the real one; injectable for tests). */
  normalizeAvatar?: (source: string | null | undefined) => Promise<AvatarNormalizeResult>;
  /** Existing metabot-update path (updateMetaBotCore) — same write + chain sync as metabot:update. */
  updateMetabotAvatar?: (metabotId: number, input: { avatar: string }) => Promise<MetabotAvatarUpdateResult>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

function normalizeMetabotId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  return id;
}

export function registerMetabotNftIpcHandlers(deps: RegisterMetabotNftIpcHandlersDeps): void {
  deps.registerIpcHandler(
    'idbots:getMetabotNfts',
    async (_event, input: { metabotId: number; kind: MetabotNftKind }) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const kind = input?.kind;
        if (kind !== 'mrc721' && kind !== 'metacontract') {
          return { success: false, error: "kind must be 'mrc721' or 'metacontract'" };
        }
        const items = await deps.getMetabotNftItems(deps.getMetabotStore(), { metabotId, kind });
        return { success: true, items };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  deps.registerIpcHandler(
    'idbots:transferMetabotMvcNft',
    async (_event, input: MetabotMvcNftTransferInput) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const result = await deps.transferMetabotMvcNft(deps.getMetabotStore(), { ...input, metabotId });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  deps.registerIpcHandler(
    'idbots:transferMetabotMrc721',
    async (_event, input: MetabotMrc721TransferInput) => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const result = await deps.transferMetabotMrc721(deps.getMetabotStore(), { ...input, metabotId });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );

  /**
   * "Use this NFT as the bot avatar" — the one-click action inside the NFT
   * Wallet modal. The artwork reference is normalized to a data-URL snapshot
   * HERE (main process) and then flows through the exact same updateMetaBotCore
   * path as metabot:update, so the local row, the avatar_blob column and the
   * on-chain /info/avatar info-pin stay consistent. Every failure is a
   * structured payload — the modal renders it instead of throwing.
   */
  deps.registerIpcHandler(
    'metabot:setNftAvatar',
    async (_event, input: MetabotSetNftAvatarInput): Promise<MetabotSetNftAvatarResult> => {
      try {
        const metabotId = normalizeMetabotId(input?.metabotId);
        const imageRef = typeof input?.imageRef === 'string' ? input.imageRef.trim() : '';
        if (!imageRef) {
          return {
            success: false,
            reason: 'empty',
            error: 'imageRef is required (metafile://<pinId>, a bare pinId, or an https artwork URL)',
          };
        }

        const normalizeAvatar = deps.normalizeAvatar ?? ((source) => normalizeAvatarToDataUrl(source));
        const normalized = await normalizeAvatar(imageRef);
        if (isAvatarNormalizeFailure(normalized)) {
          return {
            success: false,
            reason: normalized.reason,
            detail: normalized.detail,
            error: `${normalized.reason}: ${normalized.detail}`,
          };
        }

        if (!deps.updateMetabotAvatar) {
          return {
            success: false,
            reason: 'update-unavailable',
            error: 'The MetaBot avatar update path is not wired on this host',
          };
        }

        const updated = await deps.updateMetabotAvatar(metabotId, { avatar: normalized.dataUrl });
        if (!updated?.success) {
          return {
            success: false,
            reason: 'update-failed',
            error: updated?.error || 'Failed to update the MetaBot avatar',
          };
        }

        return {
          success: true,
          metabot: updated.metabot,
          sync: updated.sync,
          avatar: { mime: normalized.mime, bytes: normalized.bytes, source: normalized.source },
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  );
}
