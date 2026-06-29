import { useCallback, useEffect, useRef, useState } from 'react';
import { metaAppOwnerService } from '../../../services/metaAppOwner';
import type { MetaAppManifestInput, OwnerMetaAppRecord } from '../../../types/metaAppOwner';

const PAGE_SIZE = 12;

export interface BotOption {
  id: number;
  name: string;
  mvcAddress: string | null;
  avatar: string | null;
}

type ModalState =
  | { kind: 'none' }
  | { kind: 'publish' }
  | { kind: 'edit'; record: OwnerMetaAppRecord }
  | { kind: 'detail'; record: OwnerMetaAppRecord }
  | { kind: 'delete'; record: OwnerMetaAppRecord };

export function useOwnerMetaApps() {
  const [bots, setBots] = useState<BotOption[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);
  const [records, setRecords] = useState<OwnerMetaAppRecord[]>([]);
  const [cursor, setCursor] = useState('');
  const [cursorStack, setCursorStack] = useState<string[]>(['']);
  const [nextCursor, setNextCursor] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [chainStatus, setChainStatus] = useState<
    null | { status: 'pending' | 'success' | 'error'; txids?: string[]; error?: string }
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const loadingToken = useRef(0);

  const loadBots = useCallback(async () => {
    try {
      const res = await window.electron.metabot.list();
      if (res.success && Array.isArray(res.list)) {
        // Keep ALL bots (including those without an MVC address) so the no-MVC empty
        // state can surface; publishing for a no-MVC bot is guarded in MyAppsTab.
        const options = res.list.map((m: any) => ({
          id: m.id,
          name: m.name,
          mvcAddress: typeof m.mvc_address === 'string' && m.mvc_address ? m.mvc_address : null,
          avatar: m.avatar ?? null,
        }));
        setBots(options);
        setSelectedBotId((prev) => prev ?? options[0]?.id ?? null);
      }
    } catch {
      setBots([]);
    }
  }, []);

  const loadPage = useCallback(async (metabotId: number, pageCursor: string) => {
    const token = ++loadingToken.current;
    setLoading(true);
    setNotice('');
    try {
      const result = await metaAppOwnerService.list({ metabotId, cursor: pageCursor, size: PAGE_SIZE });
      if (token !== loadingToken.current) return;
      if (result.success) {
        setRecords(result.records);
        setNextCursor(result.nextCursor);
      } else {
        setRecords([]);
        setNextCursor('');
        setNotice(result.error || 'Failed to load MetaApps');
      }
    } catch (err) {
      if (token !== loadingToken.current) return;
      setRecords([]);
      setNotice(err instanceof Error ? err.message : 'Failed to load MetaApps');
    } finally {
      if (token === loadingToken.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadBots(); }, [loadBots]);

  useEffect(() => {
    if (selectedBotId != null) {
      setCursor(''); setCursorStack(['']); setNextCursor('');
      void loadPage(selectedBotId, '');
    } else {
      setRecords([]);
    }
  }, [selectedBotId, loadPage]);

  const refresh = useCallback(() => {
    if (selectedBotId != null) void loadPage(selectedBotId, cursor);
  }, [selectedBotId, cursor, loadPage]);

  const goNext = useCallback(() => {
    if (selectedBotId != null && nextCursor) {
      setCursorStack((s) => [...s, nextCursor]);
      setCursor(nextCursor);
      void loadPage(selectedBotId, nextCursor);
    }
  }, [selectedBotId, nextCursor, loadPage]);

  const goPrev = useCallback(() => {
    if (selectedBotId != null && cursorStack.length > 1) {
      const prevStack = cursorStack.slice(0, -1);
      const prevCursor = prevStack[prevStack.length - 1];
      setCursorStack(prevStack);
      setCursor(prevCursor);
      void loadPage(selectedBotId, prevCursor);
    }
  }, [selectedBotId, cursorStack, loadPage]);

  const submitPublish = useCallback(async (manifest: MetaAppManifestInput) => {
    if (selectedBotId == null) return;
    setSubmitting(true);
    setChainStatus({ status: 'pending' });
    try {
      const res = await metaAppOwnerService.publish({ metabotId: selectedBotId, manifest });
      if (res.success) {
        setChainStatus({ status: 'success', txids: readTxids(res.chainWrite) });
        setModal({ kind: 'none' });
        void loadPage(selectedBotId, '');
        setCursor(''); setCursorStack(['']);
      } else {
        setChainStatus({ status: 'error', error: res.error });
      }
    } catch (err) {
      setChainStatus({ status: 'error', error: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSubmitting(false);
    }
  }, [selectedBotId, loadPage]);

  const submitEdit = useCallback(async (record: OwnerMetaAppRecord, manifest: MetaAppManifestInput) => {
    if (selectedBotId == null) return;
    setSubmitting(true);
    setChainStatus({ status: 'pending' });
    try {
      const res = await metaAppOwnerService.update({
        metabotId: selectedBotId, targetPinId: record.pinId, manifest,
      });
      if (res.success) {
        setChainStatus({ status: 'success', txids: readTxids(res.chainWrite) });
        setModal({ kind: 'none' });
        void loadPage(selectedBotId, '');
        setCursor(''); setCursorStack(['']);
      } else {
        setChainStatus({ status: 'error', error: res.error });
      }
    } catch (err) {
      setChainStatus({ status: 'error', error: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSubmitting(false);
    }
  }, [selectedBotId, loadPage]);

  const submitDelete = useCallback(async (record: OwnerMetaAppRecord) => {
    if (selectedBotId == null) return;
    setSubmitting(true);
    setChainStatus({ status: 'pending' });
    try {
      const res = await metaAppOwnerService.remove({
        metabotId: selectedBotId,
        targetPinId: record.pinId,
        // Pass the create-root firstPinId so the local revoke cache hides the whole group
        // (create + all modifies), keeping the app hidden until the indexer syncs the revoke.
        firstPinId: record.firstPinId || record.pinId,
      });
      if (res.success) {
        // optimistic removal — match OAC (filter by exact pinId only). The list is already
        // collapsed to one record per firstPinId group, so removing by pinId suffices and
        // avoids accidentally hiding a sibling in the same group.
        setRecords((prev) => prev.filter((r) => r.pinId !== record.pinId));
        setChainStatus(null);
        setModal({ kind: 'none' });
      } else {
        setChainStatus({ status: 'error', error: res.error });
      }
    } catch (err) {
      setChainStatus({ status: 'error', error: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSubmitting(false);
    }
  }, [selectedBotId]);

  return {
    bots, selectedBotId, setSelectedBotId,
    records, loading, notice, setNotice,
    cursor, cursorStack, nextCursor, refresh, goNext, goPrev,
    modal, setModal,
    chainStatus, setChainStatus,
    submitting,
    submitPublish, submitEdit, submitDelete,
  };
}

function readTxids(chainWrite: unknown): string[] {
  // createPin returns { txids: string[]; pinId; totalCost } (metaidCore.ts:423).
  if (!chainWrite || typeof chainWrite !== 'object') return [];
  const cw = chainWrite as { txids?: unknown; txid?: unknown };
  if (Array.isArray(cw.txids)) return cw.txids.map(String);
  if (typeof cw.txid === 'string') return [cw.txid];
  return [];
}
