import { i18nService } from '../../services/i18n';

/** Human-first relative time ("3 天前" / "3 d ago") for chain activity anchors;
 * the block height stays alongside as the deterministic replay anchor. */
export const formatMetaTaskRelativeTime = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return i18nService.t('metatask.time.justNow');
  if (diff < 60_000) return i18nService.t('metatask.time.justNow');
  if (diff < 3_600_000) {
    return i18nService.t('metatask.time.minutesAgo').replace('{n}', String(Math.floor(diff / 60_000)));
  }
  if (diff < 86_400_000) {
    return i18nService.t('metatask.time.hoursAgo').replace('{n}', String(Math.floor(diff / 3_600_000)));
  }
  return i18nService.t('metatask.time.daysAgo').replace('{n}', String(Math.floor(diff / 86_400_000)));
};
