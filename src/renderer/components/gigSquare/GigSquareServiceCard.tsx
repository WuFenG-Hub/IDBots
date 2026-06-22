import React from 'react';
import { i18nService } from '../../services/i18n';
import type { GigSquareService } from '../../types/gigSquare';
import { formatGigSquarePrice } from '../../utils/gigSquare';
import { DEFAULT_GIG_SQUARE_PROVIDER_AVATAR } from './gigSquareProviderPresentation.js';

interface GigSquareServiceCardProps {
  service: GigSquareService;
  providerName: string;
  providerAvatarSrc: string;
  providerLookupId?: string | null;
  providerIdRow?: React.ReactNode;
  isOnline: boolean;
  hasRefundRisk?: boolean;
  refundRiskLabel?: string | null;
  actionLabel?: string;
  onOpenProviderInBrowser?: () => void;
  onOpen: () => void;
}

const SERVICE_ICON_FALLBACK_COLORS = [
  { token: 'blue', backgroundColor: '#2563eb', textColor: '#ffffff' },
  { token: 'violet', backgroundColor: '#7c3aed', textColor: '#ffffff' },
  { token: 'rose', backgroundColor: '#e11d48', textColor: '#ffffff' },
  { token: 'amber', backgroundColor: '#d97706', textColor: '#ffffff' },
  { token: 'emerald', backgroundColor: '#059669', textColor: '#ffffff' },
  { token: 'cyan', backgroundColor: '#0891b2', textColor: '#ffffff' },
  { token: 'indigo', backgroundColor: '#4f46e5', textColor: '#ffffff' },
  { token: 'slate', backgroundColor: '#475569', textColor: '#ffffff' },
] as const;

const hashString = (value: string): number => {
  let hash = 0;
  for (const char of value) {
    hash = Math.imul(hash, 31) + char.codePointAt(0)!;
    hash |= 0;
  }
  return Math.abs(hash);
};

const getServiceIconFallbackSeed = (service: GigSquareService): string => (
  [service.id, service.displayName, service.serviceName]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|') || 'service'
);

const getServiceIconFallbackText = (service: GigSquareService): string => {
  const source = [service.displayName, service.serviceName, service.id]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '?';
  const compactSource = source.replace(/\s+/g, '');
  const fallbackText = Array.from(compactSource).slice(0, 2).join('');
  return fallbackText.toUpperCase();
};

const getServiceIconFallbackColor = (service: GigSquareService) => {
  const seed = getServiceIconFallbackSeed(service);
  return SERVICE_ICON_FALLBACK_COLORS[hashString(seed) % SERVICE_ICON_FALLBACK_COLORS.length];
};

const GigSquareServiceCard: React.FC<GigSquareServiceCardProps> = ({
  service,
  providerName,
  providerAvatarSrc,
  providerLookupId,
  providerIdRow = null,
  isOnline,
  hasRefundRisk = false,
  refundRiskLabel = null,
  actionLabel = 'Open',
  onOpenProviderInBrowser,
  onOpen,
}) => {
  const price = formatGigSquarePrice(service.price, service.currency, {
    paymentTiming: service.paymentTiming,
    freeLabel: i18nService.t('gigSquareServiceFree'),
    treatZeroAsFree: true,
  });
  const iconSrc = service.serviceIcon || service.avatar || null;
  const fallbackIconText = getServiceIconFallbackText(service);
  const fallbackIconColor = getServiceIconFallbackColor(service);
  const providerSkills = Array.isArray(service.providerSkills) && service.providerSkills.length > 0
    ? [...new Set(service.providerSkills.map((skill) => String(skill || '').trim()).filter(Boolean))]
    : (service.providerSkill ? [service.providerSkill] : []);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`cursor-pointer rounded-2xl border px-4 py-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${
        hasRefundRisk
          ? 'border-amber-400/60 bg-[var(--bg-panel)] dark:bg-claude-darkSurface'
          : 'border-claude-border bg-[var(--bg-panel)] dark:border-claude-darkBorder dark:bg-claude-darkSurface'
      }`}
    >
      <div className="flex items-start gap-3">
        {iconSrc ? (
          <img
            src={iconSrc}
            alt={service.displayName}
            className="h-14 w-14 flex-shrink-0 rounded-xl border border-claude-border object-cover dark:border-claude-darkBorder"
          />
        ) : (
          <div
            data-slot="gig-square-service-icon-fallback"
            data-fallback-color={fallbackIconColor.token}
            className="flex h-14 w-14 flex-shrink-0 select-none items-center justify-center rounded-xl border border-white/20 text-base font-semibold shadow-sm"
            style={{
              backgroundColor: fallbackIconColor.backgroundColor,
              color: fallbackIconColor.textColor,
            }}
          >
            {fallbackIconText}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            data-slot="gig-square-card-title"
            className="text-[15px] font-semibold text-claude-text dark:text-claude-darkText"
          >
            {service.displayName}
          </div>
          <div
            data-slot="gig-square-card-meta-row"
            className="mt-1 flex items-center justify-between gap-3"
          >
            <div className="truncate font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {service.serviceName}
            </div>
            <div
              data-slot="gig-square-card-price"
              className="shrink-0 inline-flex items-baseline gap-1.5 text-claude-accent"
            >
              <span className="text-base font-semibold">{price.amount}</span>
              {price.unit && (
                <span className="text-[11px] font-medium uppercase tracking-wide">{price.unit}</span>
              )}
            </div>
          </div>
          <div
            data-slot="gig-square-provider-skill-chips"
            className="mt-2 flex flex-wrap items-center gap-2"
          >
            {providerSkills.map((skill) => (
              <span
                key={skill}
                className="max-w-full truncate rounded-full bg-claude-surfaceMuted px-2 py-0.5 text-[11px] font-medium text-claude-textSecondary dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary"
              >
                {skill}
              </span>
            ))}
            {refundRiskLabel && (
              <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                {refundRiskLabel}
              </span>
            )}
          </div>
          <div className="mt-2 line-clamp-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {service.description}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-claude-border/70 pt-3 dark:border-claude-darkBorder/70">
        <button
          type="button"
          disabled={!onOpenProviderInBrowser}
          onClick={(event) => {
            event.stopPropagation();
            onOpenProviderInBrowser?.();
          }}
          className="min-w-0 flex items-center gap-2 text-left disabled:cursor-default"
          title="Open provider in Bot Browser"
        >
          {isOnline && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-green-400" />
          )}
          <img
            src={providerAvatarSrc}
            alt={providerName}
            className="h-7 w-7 flex-shrink-0 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
            onError={(event) => { event.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
          />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-claude-text dark:text-claude-darkText">
              {providerName}
            </div>
            {providerLookupId && providerIdRow}
          </div>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="btn-idchat-primary-filled shrink-0 whitespace-nowrap px-3 py-1.5 text-[11px] font-medium"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
};

export default GigSquareServiceCard;
