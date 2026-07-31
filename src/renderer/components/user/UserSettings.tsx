/**
 * User Settings Component
 * Local human user identity: create / import / mnemonic backup / profile / logout.
 * Single-user model: at most one identity per device; switching accounts means
 * logging out first, then importing or creating again.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  UserCircleIcon,
  UserPlusIcon,
  KeyIcon,
  PhotoIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  ArrowLeftIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

type ViewState = 'loading' | 'empty' | 'create' | 'backup' | 'import' | 'profile';

const DEFAULT_DERIVATION_PATH = "m/44'/10001'/0'/0/0";
const AVATAR_MAX_SIZE_BYTES = 200 * 1024; // 200KB

/** Subset of the main-process PublicUserIdentity fields this panel needs. */
interface UserIdentity {
  id: number;
  name: string;
  avatar: string | null;
  metaid: string;
  globalmetaid: string | null;
  chat_public_key_pin_id: string | null;
}

const showToast = (message: string) => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

/** Map IPC error codes to localized copy; unknown/free-text errors are shown as-is. */
const resolveErrorMessage = (raw: string | undefined, context: 'create' | 'import'): string => {
  switch (raw) {
    case 'INVALID_MNEMONIC':
      return i18nService.t('userSettingsErrorInvalidMnemonic');
    case 'CHAT_PUBKEY_MISMATCH':
      return i18nService.t('userSettingsErrorChatPubkeyMismatch');
    case 'NAME_EMPTY':
      return i18nService.t(context === 'import' ? 'userSettingsErrorNameEmptyImport' : 'userSettingsErrorNameEmpty');
    case 'USER_IDENTITY_EXISTS':
      return i18nService.t('userSettingsErrorExists');
    case 'INVALID_AVATAR':
      return i18nService.t('userSettingsErrorInvalidAvatar');
    default:
      return raw || i18nService.t('userSettingsErrorUnknown');
  }
};

const inputClass = 'block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors';
const labelClass = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary';
const hintClass = 'text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary';

interface AvatarPickerProps {
  value: string;
  disabled?: boolean;
  onChange: (dataUrl: string) => void;
  onError: (message: string) => void;
}

const AvatarPicker: React.FC<AvatarPickerProps> = ({ value, disabled, onChange, onError }) => {
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX_SIZE_BYTES) {
      onError(i18nService.t('userSettingsAvatarSizeError'));
      showToast(i18nService.t('userSettingsAvatarSizeError'));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onChange(reader.result as string);
      onError('');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
        {value && value.startsWith('data:') ? (
          <img src={value} alt="" className="w-full h-full object-cover" />
        ) : (
          <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
          className="hidden"
          onChange={handleAvatarFileChange}
        />
        <button
          type="button"
          onClick={() => avatarInputRef.current?.click()}
          disabled={disabled}
          className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {i18nService.t('userSettingsAvatarUpload')}
        </button>
        <p className={hintClass}>
          {i18nService.t('userSettingsAvatarHint')}
        </p>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={disabled}
            className="mt-1 text-xs text-red-500 dark:text-red-400 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('userSettingsAvatarClear')}
          </button>
        )}
      </div>
    </div>
  );
};

const UserSettings: React.FC = () => {
  const [view, setView] = useState<ViewState>('loading');
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [loadError, setLoadError] = useState('');
  const [, setLanguage] = useState(i18nService.getLanguage());

  // Create flow
  const [createName, setCreateName] = useState('');
  const [createAvatar, setCreateAvatar] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdMnemonic, setCreatedMnemonic] = useState('');
  const [createChainSyncFailed, setCreateChainSyncFailed] = useState(false);

  // Import flow
  const [importWords, setImportWords] = useState<string[]>(Array.from({ length: 12 }, () => ''));
  const [importPath, setImportPath] = useState(DEFAULT_DERIVATION_PATH);
  const [importName, setImportName] = useState('');
  const [importAvatar, setImportAvatar] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  // Profile
  const [partialSyncWarning, setPartialSyncWarning] = useState(false);
  const [retryingSync, setRetryingSync] = useState(false);

  // Logout
  const [logoutModalOpen, setLogoutModalOpen] = useState(false);
  const [revealedMnemonic, setRevealedMnemonic] = useState('');
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState('');
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const loadIdentity = async () => {
      setLoadError('');
      try {
        const result = await window.electron.userIdentity.get();
        if (!result.success) {
          setIdentity(null);
          setView('empty');
          setLoadError(result.error || i18nService.t('userSettingsLoadFailed'));
          return;
        }
        const next = result.identity ?? null;
        setIdentity(next);
        setView(next ? 'profile' : 'empty');
      } catch (error: any) {
        setIdentity(null);
        setView('empty');
        setLoadError(error?.message || i18nService.t('userSettingsLoadFailed'));
      }
    };
    void loadIdentity();
  }, []);

  // Close the logout confirmation with Escape
  useEffect(() => {
    if (!logoutModalOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !logoutLoading) {
        setLogoutModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [logoutModalOpen, logoutLoading]);

  const createdWords = useMemo(
    () => (createdMnemonic ? createdMnemonic.split(/\s+/).filter(Boolean) : []),
    [createdMnemonic]
  );

  const revealedWords = useMemo(
    () => (revealedMnemonic ? revealedMnemonic.split(/\s+/).filter(Boolean) : []),
    [revealedMnemonic]
  );

  const normalizedImportMnemonic = useMemo(
    () => importWords.map((w) => w.trim().toLowerCase()).filter(Boolean).join(' '),
    [importWords]
  );

  const canImport = useMemo(() => {
    if (importing) return false;
    const normalizedWords = importWords.map((w) => w.trim()).filter(Boolean);
    return normalizedWords.length === 12 && importPath.trim().length > 0;
  }, [importWords, importPath, importing]);

  const handleImportWordChange = (index: number, value: string) => {
    setImportWords((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleImportPasteMnemonic = (value: string) => {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 12);
    if (parts.length === 0) return;
    setImportWords(() => Array.from({ length: 12 }, (_, i) => (parts[i] ? parts[i].toLowerCase() : '')));
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(i18nService.t('userSettingsCopied'));
    } catch {
      // ignore clipboard failures
    }
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name || creating) return;
    setCreateError('');
    setCreating(true);
    try {
      const result = await window.electron.userIdentity.create({
        name,
        avatar: createAvatar || undefined,
      });
      if (!result.success || !result.identity || !result.mnemonic) {
        setCreateError(resolveErrorMessage(result.error, 'create'));
        return;
      }
      setIdentity(result.identity);
      setCreatedMnemonic(result.mnemonic);
      setCreateChainSyncFailed(result.chainSync ? !result.chainSync.success : false);
      setView('backup');
    } catch (error: any) {
      setCreateError(resolveErrorMessage(error?.message, 'create'));
    } finally {
      setCreating(false);
    }
  };

  const handleBackupConfirmed = () => {
    setPartialSyncWarning(createChainSyncFailed);
    setCreatedMnemonic('');
    setCreateChainSyncFailed(false);
    setCreateName('');
    setCreateAvatar('');
    setCreateError('');
    setView('profile');
  };

  const handleImport = async () => {
    if (!canImport) return;
    setImportError('');
    setImporting(true);
    try {
      const result = await window.electron.userIdentity.importFromMnemonic({
        mnemonic: normalizedImportMnemonic,
        path: importPath.trim(),
        name: importName.trim() || undefined,
        avatar: importAvatar || undefined,
      });
      if (!result.success || !result.identity) {
        setImportError(resolveErrorMessage(result.error, 'import'));
        return;
      }
      setIdentity(result.identity);
      const chainSyncFailed = result.chainSync ? !result.chainSync.success : false;
      setPartialSyncWarning(result.profileSource === 'local' && chainSyncFailed);
      setImportWords(Array.from({ length: 12 }, () => ''));
      setImportPath(DEFAULT_DERIVATION_PATH);
      setImportName('');
      setImportAvatar('');
      setView('profile');
      showToast(i18nService.t('userSettingsImportSuccess'));
    } catch (error: any) {
      setImportError(resolveErrorMessage(error?.message, 'import'));
    } finally {
      setImporting(false);
    }
  };

  const handleRetryChainSync = async () => {
    if (retryingSync) return;
    setRetryingSync(true);
    try {
      const result = await window.electron.userIdentity.retryChainSync();
      const syncOk = result.success && (!result.chainSync || result.chainSync.success);
      if (result.identity) {
        setIdentity(result.identity);
      }
      if (syncOk) {
        setPartialSyncWarning(false);
        showToast(i18nService.t('userSettingsRetrySuccess'));
      } else {
        const detail = result.error || result.chainSync?.error || '';
        showToast(detail ? `${i18nService.t('userSettingsRetryFailed')}: ${detail}` : i18nService.t('userSettingsRetryFailed'));
      }
    } catch (error: any) {
      showToast(`${i18nService.t('userSettingsRetryFailed')}: ${error?.message || ''}`);
    } finally {
      setRetryingSync(false);
    }
  };

  const openLogoutModal = () => {
    setLogoutError('');
    setRevealError('');
    setRevealedMnemonic('');
    setLogoutModalOpen(true);
  };

  const handleRevealMnemonic = async () => {
    if (revealedMnemonic) {
      setRevealedMnemonic('');
      return;
    }
    if (revealLoading) return;
    setRevealLoading(true);
    setRevealError('');
    try {
      const result = await window.electron.userIdentity.revealMnemonic();
      if (result.success && result.mnemonic) {
        setRevealedMnemonic(result.mnemonic);
      } else {
        setRevealError(result.error || i18nService.t('userSettingsRevealFailed'));
      }
    } catch (error: any) {
      setRevealError(error?.message || i18nService.t('userSettingsRevealFailed'));
    } finally {
      setRevealLoading(false);
    }
  };

  const handleLogout = async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    setLogoutError('');
    try {
      const result = await window.electron.userIdentity.logout();
      if (!result.success) {
        setLogoutError(result.error || i18nService.t('userSettingsLogoutFailed'));
        return;
      }
      setIdentity(null);
      setPartialSyncWarning(false);
      setLogoutModalOpen(false);
      setRevealedMnemonic('');
      setView('empty');
      showToast(i18nService.t('userSettingsLogoutSuccess'));
    } catch (error: any) {
      setLogoutError(error?.message || i18nService.t('userSettingsLogoutFailed'));
    } finally {
      setLogoutLoading(false);
    }
  };

  const renderSubViewHeader = (titleKey: string, onBack?: () => void) => (
    <div className="flex items-center gap-3 pb-3 border-b dark:border-claude-darkBorder/60 border-claude-border/60">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={i18nService.t('back')}
          className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
      )}
      <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
        {i18nService.t(titleKey)}
      </h3>
    </div>
  );

  const renderMnemonicGrid = (words: string[]) => (
    <ol className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {words.map((word, index) => (
        <li
          key={`${index}-${word}`}
          className="rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1.5 text-sm dark:text-claude-darkText text-claude-text font-mono"
        >
          <span className="opacity-60 mr-1.5">{index + 1}.</span>
          <span>{word}</span>
        </li>
      ))}
    </ol>
  );

  const renderLoading = () => (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <ArrowPathIcon className="h-4 w-4 animate-spin shrink-0" />
        {i18nService.t('loading')}
      </div>
    </div>
  );

  const renderEmpty = () => (
    <div className="flex h-full flex-col items-center justify-center text-center px-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-claude-accent/10 dark:bg-claude-accent/20">
        <UserCircleIcon className="h-8 w-8 text-claude-accent" />
      </div>
      <h4 className="mt-4 text-base font-semibold dark:text-claude-darkText text-claude-text">
        {i18nService.t('userSettingsEmptyTitle')}
      </h4>
      <p className="mt-2 max-w-md text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('userSettingsEmptyDesc')}
      </p>
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-md">
        <button
          type="button"
          onClick={() => setView('import')}
          className="flex flex-col items-center gap-1.5 rounded-xl border-2 dark:border-claude-darkBorder border-claude-border px-4 py-4 transition-colors hover:border-claude-accent/60 dark:hover:border-claude-accent/60 dark:hover:bg-claude-darkSurfaceHover/60 hover:bg-claude-surfaceHover/60 active:scale-[0.98]"
        >
          <KeyIcon className="h-6 w-6 text-claude-accent" />
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('userSettingsImportEntry')}
          </span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('userSettingsImportEntryDesc')}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setView('create')}
          className="flex flex-col items-center gap-1.5 rounded-xl border-2 dark:border-claude-darkBorder border-claude-border px-4 py-4 transition-colors hover:border-claude-accent/60 dark:hover:border-claude-accent/60 dark:hover:bg-claude-darkSurfaceHover/60 hover:bg-claude-surfaceHover/60 active:scale-[0.98]"
        >
          <UserPlusIcon className="h-6 w-6 text-claude-accent" />
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('userSettingsCreateEntry')}
          </span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('userSettingsCreateEntryDesc')}
          </span>
        </button>
      </div>
    </div>
  );

  const renderCreate = () => (
    <div className="space-y-4">
      {renderSubViewHeader('userSettingsCreateTitle', () => setView('empty'))}

      <div className="space-y-1.5">
        <label className={labelClass}>
          {i18nService.t('userSettingsNameLabel')}
        </label>
        <input
          type="text"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          disabled={creating}
          placeholder={i18nService.t('userSettingsNamePlaceholder')}
          className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        />
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>
          {`${i18nService.t('userSettingsAvatarLabel')} ${i18nService.t('userSettingsOptional')}`}
        </label>
        <AvatarPicker
          value={createAvatar}
          disabled={creating}
          onChange={setCreateAvatar}
          onError={setCreateError}
        />
      </div>

      {createError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {createError}
        </div>
      )}

      <div className="pt-1">
        <button
          type="button"
          onClick={() => { void handleCreate(); }}
          disabled={!createName.trim() || creating}
          className="btn-idchat-primary-filled px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? i18nService.t('userSettingsCreating') : i18nService.t('userSettingsCreateSubmit')}
        </button>
      </div>
    </div>
  );

  const renderBackup = () => (
    <div className="space-y-4">
      {renderSubViewHeader('userSettingsBackupTitle')}

      <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {i18nService.t('userSettingsBackupWarning')}
        </p>
      </div>

      {createChainSyncFailed && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {i18nService.t('userSettingsChainSyncWarning')}
          </p>
        </div>
      )}

      <div className="rounded-lg bg-claude-surface dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border p-4">
        {renderMnemonicGrid(createdWords)}
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => { void handleCopy(createdWords.join(' ')); }}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
        >
          <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-1.5" />
          {i18nService.t('copy')}
        </button>
        <button
          type="button"
          onClick={handleBackupConfirmed}
          className="btn-idchat-primary-filled px-4 py-2 text-sm"
        >
          {i18nService.t('userSettingsBackupConfirm')}
        </button>
      </div>
    </div>
  );

  const renderImport = () => (
    <div className="space-y-4">
      {renderSubViewHeader('userSettingsImportTitle', () => setView('empty'))}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {importWords.map((word, index) => (
          <label key={`import-word-${index}`} className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('userSettingsWord').replace('{index}', String(index + 1))}
            <input
              type="text"
              value={word}
              disabled={importing}
              onChange={(e) => handleImportWordChange(index, e.target.value)}
              onPaste={(e) => {
                if (index === 0) {
                  handleImportPasteMnemonic(e.clipboardData.getData('text'));
                  e.preventDefault();
                }
              }}
              className="mt-1 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-2 text-sm dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder={i18nService.t('userSettingsWordPlaceholder')}
            />
          </label>
        ))}
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>
          {i18nService.t('userSettingsPathLabel')}
        </label>
        <input
          type="text"
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          disabled={importing}
          className={`${inputClass} font-mono disabled:opacity-50 disabled:cursor-not-allowed`}
        />
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>
          {`${i18nService.t('userSettingsNameLabel')} ${i18nService.t('userSettingsOptional')}`}
        </label>
        <input
          type="text"
          value={importName}
          onChange={(e) => setImportName(e.target.value)}
          disabled={importing}
          placeholder={i18nService.t('userSettingsNamePlaceholder')}
          className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        />
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>
          {`${i18nService.t('userSettingsAvatarLabel')} ${i18nService.t('userSettingsOptional')}`}
        </label>
        <AvatarPicker
          value={importAvatar}
          disabled={importing}
          onChange={setImportAvatar}
          onError={setImportError}
        />
        <p className={hintClass}>
          {i18nService.t('userSettingsImportProfileHint')}
        </p>
      </div>

      {importError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {importError}
        </div>
      )}

      <div className="pt-1">
        <button
          type="button"
          onClick={() => { void handleImport(); }}
          disabled={!canImport}
          className="btn-idchat-primary-filled px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {importing ? i18nService.t('userSettingsImporting') : i18nService.t('userSettingsImportSubmit')}
        </button>
      </div>
    </div>
  );

  const renderIdRow = (labelKey: string, value: string | null) => (
    <div className="space-y-1.5">
      <label className={labelClass}>
        {i18nService.t(labelKey)}
      </label>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border px-3 py-2 font-mono text-xs dark:text-claude-darkText text-claude-text">
          {value || '—'}
        </code>
        {value && (
          <button
            type="button"
            onClick={() => { void handleCopy(value); }}
            aria-label={i18nService.t('copy')}
            className="p-2 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
          >
            <ClipboardDocumentIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );

  const renderSyncWarning = (messageKey: string) => (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-3 min-w-0">
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {i18nService.t(messageKey)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => { void handleRetryChainSync(); }}
        disabled={retryingSync}
        className="inline-flex shrink-0 items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-amber-500/50 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
      >
        <ArrowPathIcon className={`h-3.5 w-3.5 mr-1.5 ${retryingSync ? 'animate-spin' : ''}`} />
        {retryingSync ? i18nService.t('userSettingsRetrying') : i18nService.t('userSettingsRetryChainSync')}
      </button>
    </div>
  );

  const renderProfile = () => {
    if (!identity) return null;
    const avatarUrl = identity.avatar && identity.avatar.startsWith('data:') ? identity.avatar : null;
    const nameInitial = identity.name.trim().charAt(0).toUpperCase() || '?';
    return (
      <div className="space-y-4">
        {/* Header with logout */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b dark:border-claude-darkBorder/60 border-claude-border/60">
          <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('userSettingsProfileTitle')}
          </h3>
          <button
            type="button"
            onClick={openLogoutModal}
            className="px-3 py-1.5 text-xs font-medium rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors active:scale-[0.98]"
          >
            {i18nService.t('userSettingsLogout')}
          </button>
        </div>

        {/* Identity card */}
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xl font-semibold dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {nameInitial}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold truncate dark:text-claude-darkText text-claude-text">
              {identity.name}
            </div>
          </div>
        </div>

        {renderIdRow('userSettingsGlobalMetaId', identity.globalmetaid)}
        {renderIdRow('userSettingsMetaId', identity.metaid)}

        {/* Chain sync status */}
        {!identity.chat_public_key_pin_id && renderSyncWarning('userSettingsChatPubkeyNotPinned')}
        {identity.chat_public_key_pin_id && partialSyncWarning && renderSyncWarning('userSettingsChainSyncWarning')}

        {/* Logout confirmation modal */}
        {logoutModalOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={() => { if (!logoutLoading) setLogoutModalOpen(false); }}
          >
            <div
              className="w-full max-w-lg dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal border dark:border-claude-darkBorder border-claude-border overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-6 max-h-[75vh] overflow-y-auto">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                      {i18nService.t('userSettingsLogoutConfirmTitle')}
                    </h2>
                    <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('userSettingsLogoutConfirmWarning')}
                    </p>
                  </div>
                </div>

                <div className="mt-5">
                  <button
                    type="button"
                    onClick={() => { void handleRevealMnemonic(); }}
                    disabled={revealLoading || logoutLoading}
                    className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {revealLoading
                      ? i18nService.t('loading')
                      : revealedMnemonic
                        ? i18nService.t('userSettingsHideMnemonic')
                        : i18nService.t('userSettingsRevealMnemonic')}
                  </button>
                  {revealError && (
                    <div className="mt-2 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                      {revealError}
                    </div>
                  )}
                  {revealedWords.length > 0 && (
                    <div className="mt-3 rounded-lg bg-claude-surface dark:bg-claude-darkBg border dark:border-claude-darkBorder border-claude-border p-4">
                      {renderMnemonicGrid(revealedWords)}
                    </div>
                  )}
                </div>

                {logoutError && (
                  <div className="mt-4 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                    {logoutError}
                  </div>
                )}

                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setLogoutModalOpen(false)}
                    disabled={logoutLoading}
                    className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleLogout(); }}
                    disabled={logoutLoading}
                    className="px-4 py-2 text-sm rounded-xl bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t('userSettingsLogoutConfirm')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full">
      {loadError && (
        <div className="mb-3 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {loadError}
        </div>
      )}
      {view === 'loading' && renderLoading()}
      {view === 'empty' && renderEmpty()}
      {view === 'create' && renderCreate()}
      {view === 'backup' && renderBackup()}
      {view === 'import' && renderImport()}
      {view === 'profile' && renderProfile()}
    </div>
  );
};

export default UserSettings;
