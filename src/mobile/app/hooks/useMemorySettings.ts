import { useCallback, useEffect, useState } from 'react';
import { t } from '../../i18n';
import type { CoworkChannelAPI } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';

type CoworkConfig = NonNullable<Awaited<ReturnType<CoworkChannelAPI['getConfig']>>['config']>;
export type MobileMemorySetting = 'memoryEnabled' | 'memoryImplicitUpdateEnabled' | 'memoryLlmJudgeEnabled';
type MemoryConfig = Pick<CoworkConfig, MobileMemorySetting>;

export function useMemorySettings(): {
  config: MemoryConfig | null;
  loading: boolean;
  saving: MobileMemorySetting | null;
  saved: boolean;
  error: string | null;
  setEnabled: (field: MobileMemorySetting, enabled: boolean) => Promise<boolean>;
  reload: () => Promise<void>;
} {
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<MobileMemorySetting | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMobileElectron().cowork.getConfig();
      if (!result?.success || !result.config) throw new Error('cowork config unavailable');
      setConfig({
        memoryEnabled: result.config.memoryEnabled,
        memoryImplicitUpdateEnabled: result.config.memoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: result.config.memoryLlmJudgeEnabled,
      });
      setError(null);
    } catch {
      setError(t('mobile.me.memoryLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setEnabled = useCallback(async (field: MobileMemorySetting, enabled: boolean) => {
    setSaving(field);
    setSaved(false);
    setError(null);
    try {
      const result = await getMobileElectron().cowork.setConfig({ [field]: enabled });
      if (!result?.success) throw new Error(result?.error || 'memory setting rejected');
      const confirmed = await getMobileElectron().cowork.getConfig();
      if (!confirmed?.success || !confirmed.config || confirmed.config[field] !== enabled) {
        throw new Error('memory setting readback mismatch');
      }
      setConfig((current) => current ? { ...current, [field]: enabled } : current);
      setSaved(true);
      return true;
    } catch {
      setError(t('mobile.me.memorySaveFailed'));
      return false;
    } finally {
      setSaving(null);
    }
  }, []);

  return { config, loading, saving, saved, error, setEnabled, reload };
}
