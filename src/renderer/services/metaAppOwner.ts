import type { MetaAppManifestInput, OwnerMetaAppRecord } from '../types/metaAppOwner';

export interface OwnerListResult {
  success: boolean;
  error?: string;
  records: OwnerMetaAppRecord[];
  nextCursor: string;
  total: number;
}

export interface OwnerMutationResult {
  success: boolean;
  error?: string;
  pinId?: string;
  targetPinId?: string;
  revokedPinId?: string;
  chainWrite?: unknown;
  metaappUri?: string;
  metawebUrl?: string;
}

class MetaAppOwnerService {
  async list(input: { metabotId: number; cursor?: string; size?: number }): Promise<OwnerListResult> {
    const res = await window.electron.metaappOwner.list(input);
    return {
      success: !!res.success,
      error: res.error,
      records: res.records || [],
      nextCursor: res.nextCursor || '',
      total: res.total || 0,
    };
  }

  async publish(input: { metabotId: number; manifest: MetaAppManifestInput; network?: string }): Promise<OwnerMutationResult> {
    const res = await window.electron.metaappOwner.publish({
      metabotId: input.metabotId, manifest: input.manifest, confirm: true, network: input.network,
    });
    return { success: !!res.success, error: res.error, ...res };
  }

  async update(input: { metabotId: number; targetPinId: string; firstPinId?: string; manifest: MetaAppManifestInput; network?: string }): Promise<OwnerMutationResult> {
    const res = await window.electron.metaappOwner.update({
      metabotId: input.metabotId, targetPinId: input.targetPinId, firstPinId: input.firstPinId,
      manifest: input.manifest, confirm: true, network: input.network,
    });
    return { success: !!res.success, error: res.error, ...res };
  }

  async remove(input: { metabotId: number; targetPinId: string; firstPinId?: string; network?: string }): Promise<OwnerMutationResult> {
    const res = await window.electron.metaappOwner.remove({
      metabotId: input.metabotId, targetPinId: input.targetPinId, firstPinId: input.firstPinId,
      confirm: true, network: input.network,
    });
    return { success: !!res.success, error: res.error, ...res };
  }
}

export const metaAppOwnerService = new MetaAppOwnerService();
