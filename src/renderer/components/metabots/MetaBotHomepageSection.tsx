/**
 * Homepage source editor extracted from the old MetaBotForm edit mode.
 * Renders the homepage source selector plus the per-source controls
 * (default template / MetaFile pin+upload / MetaApp pin+picker) as a
 * self-contained section so the tabbed edit form can drop it into the
 * Advanced tab. All data-slot markers and the inline control-row layout
 * are preserved verbatim for the SSR layout tests.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { OwnerMetaAppRecord } from '../../types/metaAppOwner';

type HomepageMetaAppLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const stripProtocolPrefix = (value: string, scheme: 'metaapp://' | 'metafile://') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().startsWith(scheme)
    ? trimmed.slice(scheme.length).trim()
    : trimmed;
};

const protocolUriFromInput = (value: string, scheme: 'metaapp://' | 'metafile://') => {
  const ref = stripProtocolPrefix(value, scheme);
  return ref ? `${scheme}${ref}` : '';
};

const ownerMetaAppName = (record: OwnerMetaAppRecord) =>
  (record.appName || record.title || i18nService.t('metabotHomepageUntitledMetaApp')).trim();

export interface HomepageSectionValues {
  homepage_source: 'default' | 'metafile' | 'metaapp';
  homepage_metafile_uri: string;
  homepage_metafile_content_type: string;
  homepage_metaapp_pin: string;
}

export type HomepageSectionField = keyof HomepageSectionValues;

/** Compose the final homepage JSON string (or null) from current selection. Throws on invalid. */
export function composeHomepageForSave(values: HomepageSectionValues): string | null {
  if (values.homepage_source === 'default') return null;
  if (values.homepage_source === 'metafile') {
    const pin = stripProtocolPrefix(values.homepage_metafile_uri, 'metafile://');
    if (!pin) throw new Error(i18nService.t('metabotHomepageErrNoFile'));
    if (/\s/u.test(pin) || /:\/\//.test(pin)) {
      throw new Error(i18nService.t('metabotHomepageErrInvalidMetafilePin'));
    }
    const contentType = values.homepage_metafile_content_type.trim() || 'application/octet-stream';
    return JSON.stringify({ uri: `metafile://${pin}`, renderer: 'auto', contentType });
  }
  // metaapp
  const stripped = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');
  if (!stripped || /\s/u.test(stripped) || /:\/\//.test(stripped)) {
    throw new Error(i18nService.t('metabotHomepageErrInvalidPin'));
  }
  return JSON.stringify({ uri: `metaapp://${stripped}`, renderer: 'metaapp', contentType: 'application/vnd.metaapp' });
}

// Same row/label/input chrome the edit form uses, so the section blends in.
const rowClass = 'grid grid-cols-1 md:grid-cols-[132px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const inputChromeClass = 'px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
const homepageInlineButtonClass = 'inline-flex h-[38px] shrink-0 items-center justify-center gap-1.5 px-3 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
const homepageProtocolInputClass = 'flex h-[38px] min-w-0 flex-1 items-center overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg focus-within:ring-2 focus-within:ring-claude-accent';
const homepageProtocolPrefixClass = 'flex h-full shrink-0 items-center border-r dark:border-claude-darkBorder border-claude-border px-2 text-xs font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary';
const homepageProtocolFieldClass = 'h-full min-w-0 flex-1 bg-transparent px-2 text-sm font-mono dark:text-claude-darkText text-claude-text focus:outline-none';

interface MetaBotHomepageSectionProps {
  values: HomepageSectionValues;
  onChange: (field: HomepageSectionField, value: string) => void;
  /** Metabot id for homepage file upload / owner MetaApp listing. Null disables both. */
  metabotId?: number | null;
  /** Open the current Bot's default template homepage in Bot Browser. */
  onOpenDefaultHomepage?: () => void;
  /** Open a MetaApp homepage preview by its pin id (best-effort; browser may fail to resolve). */
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  /** Open the MetaApps surface so the user can publish a MetaApp for this Bot. */
  onRequestMetaApps?: () => void;
}

export const MetaBotHomepageSection: React.FC<MetaBotHomepageSectionProps> = ({
  values,
  onChange,
  metabotId,
  onOpenDefaultHomepage,
  onPreviewMetaAppHomepage,
  onRequestMetaApps,
}) => {
  const homepageFileInputRef = useRef<HTMLInputElement>(null);
  const homepageMetaAppsRequestIdRef = useRef(0);
  const [homepageUploading, setHomepageUploading] = useState(false);
  const [homepageUploadError, setHomepageUploadError] = useState('');
  const [homepageMetaAppPickerOpen, setHomepageMetaAppPickerOpen] = useState(false);
  const [homepageMetaAppLoadStatus, setHomepageMetaAppLoadStatus] = useState<HomepageMetaAppLoadStatus>('idle');
  const [homepageMetaAppLoadError, setHomepageMetaAppLoadError] = useState('');
  const [homepageMetaAppRecords, setHomepageMetaAppRecords] = useState<OwnerMetaAppRecord[]>([]);

  useEffect(() => {
    homepageMetaAppsRequestIdRef.current += 1;
    setHomepageMetaAppPickerOpen(false);
    setHomepageMetaAppLoadStatus('idle');
    setHomepageMetaAppLoadError('');
    setHomepageMetaAppRecords([]);
  }, [metabotId]);

  // Internal wrapper so picker/upload side effects stay encapsulated here while
  // the actual value changes flow back to the parent form state.
  const handleChange = (field: HomepageSectionField, value: string) => {
    onChange(field, value);
  };

  const handleHomepageSourceChange = (source: HomepageSectionValues['homepage_source']) => {
    handleChange('homepage_source', source);
    setHomepageMetaAppPickerOpen(false);
    setHomepageUploadError('');
  };

  const handleHomepageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || metabotId == null) return;
    setHomepageUploading(true);
    setHomepageUploadError('');
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = String(reader.result || '');
          const m = /^data:[^;]+;base64,(.+)$/.exec(result);
          resolve(m ? m[1] : '');
        };
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      if (!base64) throw new Error('empty');
      const res = await window.electron.idbots.uploadMetabotHomepageFile({
        metabotId,
        fileName: file.name,
        contentType: file.type || undefined,
        base64,
      });
      if (!res.success || !res.metafileUri) {
        throw new Error(res.error || i18nService.t('metabotSaveFailed'));
      }
      handleChange('homepage_metafile_uri', res.metafileUri);
      handleChange('homepage_metafile_content_type', res.contentType || file.type || '');
      handleChange('homepage_source', 'metafile');
    } catch (err) {
      setHomepageUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setHomepageUploading(false);
      e.target.value = '';
    }
  };

  const loadHomepageMetaApps = useCallback(async () => {
    if (metabotId == null) {
      setHomepageMetaAppLoadStatus('loaded');
      setHomepageMetaAppRecords([]);
      return;
    }
    const requestId = ++homepageMetaAppsRequestIdRef.current;
    setHomepageMetaAppLoadStatus('loading');
    setHomepageMetaAppLoadError('');
    try {
      const result = await window.electron.metaappOwner.list({ metabotId, size: 24 });
      if (requestId !== homepageMetaAppsRequestIdRef.current) return;
      if (!result.success) {
        throw new Error(result.error || i18nService.t('metabotHomepageMetaAppsLoadFailed'));
      }
      setHomepageMetaAppRecords((result.records || []).filter((record) => Boolean(record.pinId)));
      setHomepageMetaAppLoadStatus('loaded');
    } catch (err) {
      if (requestId !== homepageMetaAppsRequestIdRef.current) return;
      setHomepageMetaAppRecords([]);
      setHomepageMetaAppLoadStatus('error');
      setHomepageMetaAppLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [metabotId]);

  const openHomepageMetaAppPicker = () => {
    setHomepageMetaAppPickerOpen(true);
    void loadHomepageMetaApps();
  };

  const handleChooseHomepageMetaApp = (record: OwnerMetaAppRecord) => {
    handleChange('homepage_metaapp_pin', record.pinId);
    setHomepageMetaAppPickerOpen(false);
    setHomepageMetaAppLoadError('');
  };

  const homepageMetafilePin = stripProtocolPrefix(values.homepage_metafile_uri, 'metafile://');
  const homepageMetaAppPin = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');

  return (
    <div className={rowClass}>
      <label htmlFor="metabot-homepage" className={labelClass}>
        {i18nService.t('metabotHomepage')}
      </label>
      <div className="min-w-0 space-y-1.5">
        <div
          data-slot="metabot-homepage-control-row"
          className="flex min-w-0 items-center gap-2"
        >
          <select
            id="metabot-homepage"
            value={values.homepage_source}
            onChange={(e) => handleHomepageSourceChange(e.target.value as HomepageSectionValues['homepage_source'])}
            className={`${inputChromeClass} h-[38px] w-[9.5rem] shrink-0`}
          >
            <option value="default">{i18nService.t('metabotHomepageDefault')}</option>
            <option value="metafile">{i18nService.t('metabotHomepageMetafile')}</option>
            <option value="metaapp">{i18nService.t('metabotHomepageMetaapp')}</option>
          </select>

          {values.homepage_source === 'default' && (
            <div className="min-w-0 flex-1">
              {onOpenDefaultHomepage ? (
                <button
                  type="button"
                  data-slot="metabot-homepage-view"
                  onClick={onOpenDefaultHomepage}
                  className={homepageInlineButtonClass}
                  title={i18nService.t('metabotHomepageView')}
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  <span>{i18nService.t('metabotHomepageView')}</span>
                </button>
              ) : (
                <p className={`${hintClass} mt-0 truncate`}>
                  {i18nService.t('metabotHomepageDefaultDesc')}
                </p>
              )}
            </div>
          )}

          {values.homepage_source === 'metafile' && (
            <div className="min-w-0 flex-1 flex items-center gap-2">
              <input
                ref={homepageFileInputRef}
                type="file"
                className="hidden"
                onChange={handleHomepageFileChange}
              />
              <label className={homepageProtocolInputClass}>
                <span className={homepageProtocolPrefixClass}>metafile://</span>
                <input
                  type="text"
                  data-slot="metabot-homepage-metafile-pin"
                  value={homepageMetafilePin}
                  onChange={(e) => handleChange('homepage_metafile_uri', protocolUriFromInput(e.target.value, 'metafile://'))}
                  placeholder={i18nService.t('metabotHomepageMetafilePinPlaceholder')}
                  className={homepageProtocolFieldClass}
                />
              </label>
              <button
                type="button"
                data-slot="metabot-homepage-metafile-upload"
                onClick={() => homepageFileInputRef.current?.click()}
                disabled={homepageUploading || metabotId == null}
                className={homepageInlineButtonClass}
                title={metabotId == null ? i18nService.t('metabotHomepageMetafileDisabledHint') : undefined}
              >
                {homepageUploading ? i18nService.t('metabotHomepageUploading') : i18nService.t('metabotHomepageMetafileUpload')}
              </button>
              {homepageUploadError && (
                <p className="min-w-0 truncate text-xs text-red-500">{homepageUploadError}</p>
              )}
            </div>
          )}

          {values.homepage_source === 'metaapp' && (
            <div className="min-w-0 flex-1 flex items-center gap-2">
              <label className={homepageProtocolInputClass}>
                <span className={homepageProtocolPrefixClass}>metaapp://</span>
                <input
                  type="text"
                  data-slot="metabot-homepage-metaapp-pin"
                  value={homepageMetaAppPin}
                  onChange={(e) => handleChange('homepage_metaapp_pin', stripProtocolPrefix(e.target.value, 'metaapp://'))}
                  placeholder={i18nService.t('metabotHomepageMetaappPinPlaceholder')}
                  className={homepageProtocolFieldClass}
                />
              </label>
              <div className="relative shrink-0">
                <button
                  type="button"
                  data-slot="metabot-homepage-metaapp-select"
                  onClick={openHomepageMetaAppPicker}
                  disabled={metabotId == null}
                  aria-haspopup="dialog"
                  aria-expanded={homepageMetaAppPickerOpen}
                  className={homepageInlineButtonClass}
                >
                  {i18nService.t('metabotHomepageMetaappSelect')}
                </button>
                {homepageMetaAppPickerOpen && (
                  <div
                    data-slot="metabot-homepage-metaapp-picker"
                    role="dialog"
                    aria-label={i18nService.t('metabotHomepageMetaappSelect')}
                    className="absolute right-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white shadow-xl"
                  >
                    {homepageMetaAppLoadStatus === 'loading' && (
                      <div className="px-3 py-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('metabotHomepageLoadingMetaApps')}
                      </div>
                    )}
                    {homepageMetaAppLoadStatus === 'error' && (
                      <div className="space-y-2 px-3 py-3 text-sm">
                        <p className="font-medium text-red-500 dark:text-red-400">
                          {i18nService.t('metabotHomepageMetaAppsLoadFailed')}
                        </p>
                        <p className="break-words text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {homepageMetaAppLoadError}
                        </p>
                        <button
                          type="button"
                          onClick={() => void loadHomepageMetaApps()}
                          className={homepageInlineButtonClass}
                        >
                          {i18nService.t('retry')}
                        </button>
                      </div>
                    )}
                    {homepageMetaAppLoadStatus === 'loaded' && homepageMetaAppRecords.length === 0 && (
                      <div className="space-y-2 px-3 py-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        <p className="font-medium dark:text-claude-darkText text-claude-text">
                          {i18nService.t('metabotHomepageNoMetaAppsTitle')}
                        </p>
                        <p>{i18nService.t('metabotHomepageNoMetaAppsMessage')}</p>
                        {onRequestMetaApps && (
                          <button
                            type="button"
                            onClick={onRequestMetaApps}
                            className="btn-idchat-primary-filled px-3 py-2 text-sm"
                          >
                            {i18nService.t('metabotHomepageCreateMetaApp')}
                          </button>
                        )}
                      </div>
                    )}
                    {homepageMetaAppLoadStatus === 'loaded' && homepageMetaAppRecords.length > 0 && (
                      <div className="max-h-72 overflow-y-auto py-1">
                        {homepageMetaAppRecords.map((record) => (
                          <button
                            key={record.pinId}
                            type="button"
                            onClick={() => handleChooseHomepageMetaApp(record)}
                            className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg dark:bg-claude-darkBg bg-claude-surface text-xs font-semibold dark:text-claude-darkText text-claude-text">
                              {ownerMetaAppName(record).slice(0, 2).toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
                                {ownerMetaAppName(record)}
                              </span>
                              <code className="block truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                {record.pinId}
                              </code>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {onPreviewMetaAppHomepage && (
                <button
                  type="button"
                  data-slot="metabot-homepage-metaapp-preview"
                  onClick={() => {
                    const pin = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');
                    if (pin) void onPreviewMetaAppHomepage(pin);
                  }}
                  disabled={!homepageMetaAppPin}
                  className={homepageInlineButtonClass}
                >
                  {i18nService.t('metabotHomepageMetaappPreview')}
                </button>
              )}
            </div>
          )}
        </div>

        <p data-slot="metabot-homepage-hint" className={hintClass}>{i18nService.t('metabotHomepageHint')}</p>
      </div>
    </div>
  );
};

export default MetaBotHomepageSection;
