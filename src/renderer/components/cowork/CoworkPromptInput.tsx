import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { PaperAirplaneIcon, StopIcon, FolderIcon } from '@heroicons/react/24/solid';
import { PaperClipIcon, XMarkIcon, SparklesIcon } from '@heroicons/react/24/outline';
import ModelSelector from '../ModelSelector';
import ContextUsageRing from '../ContextUsageRing';
import FolderSelectorPopover from './FolderSelectorPopover';
import PermissionModeSelector from './PermissionModeSelector';
import { SkillsButton, ActiveSkillBadge } from '../skills';
import KernelSelector from './KernelSelector';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setDraftPrompt, setSessionDraft } from '../../store/slices/coworkSlice';
import { setSkills, toggleActiveSkill } from '../../store/slices/skillSlice';
import { Skill } from '../../types/skill';
import type { CoworkContextUsage, CoworkPermissionMode } from '../../types/cowork';
import type { Model } from '../../store/slices/modelSlice';
import { getCompactFolderName } from '../../utils/path';
import {
  createVersionedComposerField,
  runComposerSubmission,
  type VersionedComposerField,
  type VersionedComposerSnapshot,
} from './coworkPromptSubmission';

type CoworkAttachment = {
  path: string;
  name: string;
};

interface CoworkPromptInputStateOptions {
  value: string;
  isStreaming: boolean;
  disabled: boolean;
  steerDisabled: boolean;
  attachmentCount: number;
}

export const deriveCoworkPromptInputState = ({
  value,
  isStreaming,
  disabled,
  steerDisabled,
  attachmentCount,
}: CoworkPromptInputStateOptions) => {
  const hasTextInput = Boolean(value.trim());
  const isSteerSubmit = isStreaming && hasTextInput && !steerDisabled;
  const showStopButton = isStreaming && (!hasTextInput || steerDisabled);
  const canSubmit = !disabled && (!isStreaming
    ? hasTextInput || attachmentCount > 0
    : isSteerSubmit);
  return { hasTextInput, isSteerSubmit, showStopButton, canSubmit };
};

export interface CoworkContextMenuDerivedState {
  canCut: boolean;
  canCopy: boolean;
  canSelectAll: boolean;
}

export const deriveCoworkContextMenuState = ({
  valueLength,
  selectionStart,
  selectionEnd,
  disabled,
}: {
  valueLength: number;
  selectionStart: number;
  selectionEnd: number;
  disabled: boolean;
}): CoworkContextMenuDerivedState => {
  const hasSelection = selectionStart >= 0 && selectionEnd > selectionStart;
  return {
    canCut: !disabled && hasSelection,
    canCopy: hasSelection,
    canSelectAll: !disabled && valueLength > 0,
  };
};

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 168;
const CONTEXT_MENU_PADDING = 8;

const ContextMenuItem: React.FC<{
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, shortcut, disabled = false, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-40 disabled:hover:bg-transparent disabled:dark:hover:bg-transparent disabled:cursor-not-allowed"
  >
    <span className="flex-1 truncate">{label}</span>
    {shortcut && (
      <span className="flex-shrink-0 text-xs opacity-50 dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {shortcut}
      </span>
    )}
  </button>
);

const getFileNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

const getSkillDirectoryFromPath = (skillPath: string): string => {
  const normalized = skillPath.trim().replace(/\\/g, '/');
  return normalized.replace(/\/SKILL\.md$/i, '') || normalized;
};

const buildInlinedSkillPrompt = (skill: Skill): string => {
  const skillDirectory = getSkillDirectoryFromPath(skill.skillPath);
  return [
    `## Skill: ${skill.name}`,
    '<skill_context>',
    `  <location>${skill.skillPath}</location>`,
    `  <directory>${skillDirectory}</directory>`,
    '  <path_rules>',
    '    Resolve relative file references from this skill against <directory>.',
    '    Do not assume skills are under the current workspace directory.',
    '  </path_rules>',
    '</skill_context>',
    '',
    skill.prompt,
  ].join('\n');
};

export interface CoworkPromptInputRef {
  /** 设置输入框值 */
  setValue: (value: string) => void;
  /** 聚焦输入框 */
  focus: () => void;
  /** 从外部（如宿主面板自带的附件按钮）追加附件 */
  addAttachments: (paths: string[]) => void;
}

interface CoworkPromptInputProps {
  onSubmit: (prompt: string, skillPrompt?: string) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  steerDisabled?: boolean;
  scopeKey?: string;
  size?: 'normal' | 'large';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  /** Show the built-in attachment (paperclip) button. Hosts with their own attachment button can hide it. */
  showAttachmentButton?: boolean;
  /** When set, restrict model choices to this LLM provider (e.g. from MetaBot llm_id). */
  restrictToLlmId?: string | null;
  /** Controlled per-session model: display value (null = fall back to the global default) + change handler. */
  modelValue?: Model | null;
  onModelChange?: (model: Model) => void;
  /** Estimated context-window usage of the current conversation; shows a ring indicator when provided. */
  contextUsage?: CoworkContextUsage | null;
  onManageSkills?: () => void;
  /** Context-aware follow-up suggestions from the SDK; rendered as clickable chips. */
  suggestedPrompts?: string[];
  /** Show the permission-mode selector in the footer (new-session creation). */
  showPermissionModeSelector?: boolean;
  /** Kernel the current session runs on ('dsh' when its handle is dsh:-prefixed). */
  sessionKernel?: 'dsh' | 'claude';
  /** Controlled permission-mode value for the footer selector. */
  permissionMode?: CoworkPermissionMode;
  /** Callback when the footer permission-mode selector changes. */
  onPermissionModeChange?: (mode: CoworkPermissionMode) => void;
}

const CoworkPromptInput = React.forwardRef<CoworkPromptInputRef, CoworkPromptInputProps>(
  (props, ref) => {
    const {
      onSubmit,
      onStop,
      isStreaming = false,
      placeholder = 'Enter your task...',
      disabled = false,
      steerDisabled = false,
      scopeKey,
      size = 'normal',
      workingDirectory = '',
      onWorkingDirectoryChange,
      showFolderSelector = false,
      showModelSelector = false,
      showAttachmentButton = true,
      restrictToLlmId,
      modelValue = null,
      onModelChange,
      contextUsage,
      onManageSkills,
      suggestedPrompts,
      showPermissionModeSelector = false,
      sessionKernel,
      permissionMode,
      onPermissionModeChange,
    } = props;
    const isMac = (window as { electron?: { platform?: string } }).electron?.platform === 'darwin';
    const dispatch = useDispatch();
    const draftPrompt = useSelector((state: RootState) => state.cowork.draftPrompt);
    const sessionDrafts = useSelector((state: RootState) => state.cowork.sessionDrafts);
    // Scoped composers (session steer input, Bot Browser panel) restore their
    // draft from the per-scope store entry, so switching sessions keeps each
    // session's typed text; the unscoped New Task composer owns the global draft.
    const initialDraftRef = useRef(scopeKey ? (sessionDrafts[scopeKey]?.value ?? '') : draftPrompt);
    const initialAttachmentsRef = useRef(scopeKey ? (sessionDrafts[scopeKey]?.attachments ?? []) : []);
    const [value, setValue] = useState(initialDraftRef.current);
    const [attachments, setAttachments] = useState<CoworkAttachment[]>(initialAttachmentsRef.current);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const dragDepthRef = useRef(0);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    // Selection captured when the context menu opened; only drives the
    // enabled/disabled state of the menu items. Actions re-read the live
    // selection from the textarea so streaming updates cannot desync them.
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
    const [contextMenuSelection, setContextMenuSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
    const activeScopeKeyRef = useRef(scopeKey);
    // Publish composer state: scoped composers write to the per-session draft
    // store, the unscoped New Task composer keeps owning the global draft. The
    // versioned fields call this on every change, including takeAndClear after
    // a submit, which is what makes drafts persist across session switches.
    const publishComposerState = useCallback((nextValue: string, nextAttachments: CoworkAttachment[]) => {
      const scope = activeScopeKeyRef.current;
      if (scope) {
        dispatch(setSessionDraft({ sessionId: scope, value: nextValue, attachments: nextAttachments }));
      } else {
        dispatch(setDraftPrompt(nextValue));
      }
    }, [dispatch]);
    const draftFieldRef = useRef<VersionedComposerField<string> | null>(null);
    const attachmentFieldRef = useRef<VersionedComposerField<CoworkAttachment[]> | null>(null);
    if (!draftFieldRef.current) {
      draftFieldRef.current = createVersionedComposerField(initialDraftRef.current, () => '', (nextValue) => {
        setValue(nextValue);
        publishComposerState(nextValue, attachmentFieldRef.current?.get() ?? []);
      });
    }
    if (!attachmentFieldRef.current) {
      attachmentFieldRef.current = createVersionedComposerField(initialAttachmentsRef.current, () => [], (nextAttachments) => {
        setAttachments(nextAttachments);
        publishComposerState(draftFieldRef.current?.get() ?? '', nextAttachments);
      });
    }

  // 暴露方法给父组件
  React.useImperativeHandle(ref, () => ({
    setValue: (newValue: string) => {
      draftFieldRef.current?.set(newValue);
      // 触发自动调整高度
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
        }
      });
    },
    focus: () => {
      textareaRef.current?.focus();
    },
    addAttachments: (paths: string[]) => {
      const field = attachmentFieldRef.current;
      if (!field) return;
      const next = [...field.get()];
      for (const path of paths) {
        if (!path || next.some((attachment) => attachment.path === path)) continue;
        next.push({ path, name: getFileNameFromPath(path) });
      }
      field.set(next);
    },
  }));

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const inputFileLabel = i18nService.t('coworkInputFileLabel');

  const isLarge = size === 'large';
  const minHeight = isLarge ? 60 : 24;
  const maxHeight = isLarge ? 200 : 200;

  // Load skills on mount
  useEffect(() => {
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();
  }, [dispatch]);

  useEffect(() => {
    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    });
    return () => {
      unsubscribe();
    };
  }, [dispatch]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
    }
  }, [value, minHeight, maxHeight]);

  React.useLayoutEffect(() => () => {
    draftFieldRef.current?.invalidate();
    attachmentFieldRef.current?.invalidate();
  }, []);

  useEffect(() => {
    if (activeScopeKeyRef.current !== scopeKey) {
      // The composer is reused with a different scope (normally CoworkSessionDetail
      // remounts it per session via key, so this is defensive): invalidate any
      // in-flight submission snapshots and load the new scope's stored draft.
      activeScopeKeyRef.current = scopeKey;
      draftFieldRef.current?.invalidate();
      attachmentFieldRef.current?.invalidate();
      if (scopeKey) {
        const stored = sessionDrafts[scopeKey];
        draftFieldRef.current?.set(stored?.value ?? '');
        attachmentFieldRef.current?.set(stored?.attachments ?? []);
      } else {
        draftFieldRef.current?.set(draftPrompt);
        attachmentFieldRef.current?.set([]);
      }
    }
  }, [scopeKey, sessionDrafts, draftPrompt]);

  useEffect(() => {
    const handleFocusInput = () => {
      // Navigation events (New Chat, session shortcuts) only focus the input;
      // they must never clear it. Drafts are owned by their scope: the New
      // Task composer keeps the global draft and each session keeps its own
      // stored draft. They are cleared only by a successful submit or when
      // the session itself is deleted.
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    };
    window.addEventListener('cowork:focus-input', handleFocusInput);
    return () => {
      window.removeEventListener('cowork:focus-input', handleFocusInput);
    };
  }, []);

  useEffect(() => {
    if (workingDirectory?.trim()) {
      setShowFolderRequiredWarning(false);
    }
  }, [workingDirectory]);

  const handleSubmit = useCallback(async () => {
    if (disabled || (isStreaming && steerDisabled)) return;

    const draftField = draftFieldRef.current;
    const attachmentField = attachmentFieldRef.current;
    if (!draftField || !attachmentField) return;
    const submittedValue = draftField.get();
    const submittedAttachments = attachmentField.get();
    const trimmedValue = submittedValue.trim();
    if (isStreaming && !trimmedValue) return;
    if (!isStreaming && showFolderSelector && !workingDirectory?.trim()) {
      setShowFolderRequiredWarning(true);
      return;
    }
    if (!isStreaming && !trimmedValue && submittedAttachments.length === 0) return;
    setShowFolderRequiredWarning(false);

    // Get active skills prompts and combine them
    const activeSkills = isStreaming
      ? []
      : activeSkillIds
        .map(id => skills.find(s => s.id === id))
        .filter((s): s is Skill => s !== undefined);
    const skillPrompt = activeSkills.length > 0
      ? activeSkills.map(buildInlinedSkillPrompt).join('\n\n')
      : undefined;

    const attachmentLines = submittedAttachments.map((attachment) =>
      `${inputFileLabel}: ${attachment.path}`
    ).join('\n');
    const finalPrompt = isStreaming
      ? trimmedValue
      : trimmedValue
        ? (attachmentLines ? `${trimmedValue}\n\n${attachmentLines}` : trimmedValue)
        : attachmentLines;

    const draftSnapshot = draftField.takeAndClear();
    let attachmentSnapshot: VersionedComposerSnapshot<CoworkAttachment[]> | null = null;
    if (!isStreaming) {
      attachmentSnapshot = attachmentField.takeAndClear();
    }
    try {
      const accepted = await runComposerSubmission(
        draftField,
        draftSnapshot,
        () => onSubmit(finalPrompt, isStreaming ? undefined : skillPrompt),
      );
      if (accepted === false && attachmentSnapshot) {
        attachmentField.restoreIfUnchanged(attachmentSnapshot);
      }
    } catch (error) {
      if (attachmentSnapshot) {
        attachmentField.restoreIfUnchanged(attachmentSnapshot);
      }
      console.error('Cowork prompt submission failed:', error);
    }
  }, [isStreaming, disabled, steerDisabled, onSubmit, activeSkillIds, skills, inputFileLabel, showFolderSelector, workingDirectory]);

  const handleSelectSkill = useCallback((skill: Skill) => {
    dispatch(toggleActiveSkill(skill.id));
  }, [dispatch]);

  const handleManageSkills = useCallback(() => {
    if (onManageSkills) {
      onManageSkills();
    }
  }, [onManageSkills]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to submit, Shift+Enter for new line
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey && !isComposing && !disabled) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  const handleStopClick = () => {
    if (onStop) {
      onStop();
    }
  };

  const containerClass = isLarge
    ? 'relative rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-card focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-claude-accent/40 focus-within:border-claude-accent'
    : 'relative flex items-end gap-2 p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface';

  const textareaClass = isLarge
    ? `w-full resize-none bg-transparent px-4 pt-2.5 pb-2 dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary/60 placeholder:text-claude-textSecondary/60 focus:outline-none text-[15px] leading-6 min-h-[${minHeight}px] max-h-[${maxHeight}px]`
    : 'flex-1 resize-none bg-transparent dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary placeholder:text-claude-textSecondary focus:outline-none text-sm leading-relaxed min-h-[24px] max-h-[200px]';

  const truncatePath = (path: string, maxLength = 30): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };

  const handleFolderSelect = (path: string) => {
    if (onWorkingDirectoryChange) {
      onWorkingDirectoryChange(path);
    }
  };

  const addAttachment = useCallback((path: string) => {
    if (!path) return;
    const field = attachmentFieldRef.current;
    if (!field) return;
    const prev = field.get();
    if (prev.some((attachment) => attachment.path === path)) {
      return;
    }
    field.set([...prev, { path, name: getFileNameFromPath(path) }]);
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const getNativeFilePath = useCallback((file: File): string | null => {
    const maybePath = (file as File & { path?: string }).path;
    if (typeof maybePath === 'string' && maybePath.trim()) {
      return maybePath;
    }
    return null;
  }, []);

  const saveInlineFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const dataBase64 = await fileToBase64(file);
      if (!dataBase64) {
        return null;
      }
      const result = await window.electron.dialog.saveInlineFile({
        dataBase64,
        fileName: file.name,
        mimeType: file.type,
        cwd: workingDirectory,
      });
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to save inline file:', error);
      return null;
    }
  }, [fileToBase64, workingDirectory]);

  const handleIncomingFiles = useCallback(async (fileList: FileList | File[]) => {
    if (disabled || isStreaming) return;
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      const nativePath = getNativeFilePath(file);
      if (nativePath) {
        addAttachment(nativePath);
        continue;
      }

      const stagedPath = await saveInlineFile(file);
      if (stagedPath) {
        addAttachment(stagedPath);
      }
    }
  }, [addAttachment, disabled, getNativeFilePath, isStreaming, saveInlineFile]);

  const handleAddFile = useCallback(async () => {
    try {
      const result = await window.electron.dialog.selectFile({
        title: i18nService.t('coworkAddFile'),
      });
      if (result.success && result.path) {
        addAttachment(result.path);
      }
    } catch (error) {
      console.error('Failed to select file:', error);
    }
  }, [addAttachment]);

  const handleRemoveAttachment = useCallback((path: string) => {
    const field = attachmentFieldRef.current;
    if (!field) return;
    field.set(field.get().filter((attachment) => attachment.path !== path));
  }, []);

  const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    if (dataTransfer.files.length > 0) return true;
    return Array.from(dataTransfer.types).includes('Files');
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (!disabled && !isStreaming) {
      setIsDraggingFiles(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || isStreaming ? 'none' : 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (disabled || isStreaming) return;
    void handleIncomingFiles(event.dataTransfer.files);
  };

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || isStreaming) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void handleIncomingFiles(files);
  }, [disabled, handleIncomingFiles, isStreaming]);

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null);
  }, []);

  const handleTextareaContextMenu = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    if (disabled || (isStreaming && steerDisabled)) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenuSelection({
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    });
    const x = Math.min(
      Math.max(CONTEXT_MENU_PADDING, event.clientX),
      window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_PADDING
    );
    const y = Math.min(
      Math.max(CONTEXT_MENU_PADDING, event.clientY),
      window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_PADDING
    );
    setContextMenuPosition({ x, y });
  };

  const contextMenuDerived = deriveCoworkContextMenuState({
    valueLength: value.length,
    selectionStart: contextMenuSelection.start,
    selectionEnd: contextMenuSelection.end,
    disabled: disabled || (isStreaming && steerDisabled),
  });

  /** Re-read the live selection from the focused textarea (menu keeps it focused). */
  const readLiveSelection = (): { start: number; end: number } => {
    const textarea = textareaRef.current;
    if (!textarea) return { start: 0, end: 0 };
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
  };

  /**
   * Apply a text change through the DOM and let React's onChange drive the
   * versioned composer field, keeping cursor/selection semantics intact.
   */
  const applyTextareaChange = (replaceFrom: number, replaceTo: number, text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.setRangeText(text, replaceFrom, replaceTo, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const runContextMenuSelectAll = () => {
    closeContextMenu();
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.select();
  };

  const runContextMenuCopy = () => {
    closeContextMenu();
    const { start, end } = readLiveSelection();
    const selectedText = (draftFieldRef.current?.get() ?? '').slice(start, end);
    if (!selectedText) return;
    void navigator.clipboard.writeText(selectedText).catch((error) => {
      console.error('Failed to copy from cowork input:', error);
    });
  };

  const runContextMenuCut = () => {
    closeContextMenu();
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readLiveSelection();
    const selectedText = (draftFieldRef.current?.get() ?? '').slice(start, end);
    if (!selectedText) return;
    void (async () => {
      try {
        // Only remove the text after the clipboard write succeeds, otherwise
        // a failed copy would silently delete the selection.
        await navigator.clipboard.writeText(selectedText);
        applyTextareaChange(start, end, '');
      } catch (error) {
        console.error('Failed to cut from cowork input:', error);
      }
    })();
  };

  const runContextMenuPaste = () => {
    closeContextMenu();
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readLiveSelection();
    void (async () => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch (error) {
        console.error('Failed to read clipboard for cowork paste:', error);
        return;
      }
      // Clipboard items without text (e.g. copied files) must not replace
      // the current selection with nothing.
      if (!text) return;
      applyTextareaChange(start, end, text);
    })();
  };

  useEffect(() => {
    if (!contextMenuPosition) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!contextMenuRef.current?.contains(target)) {
        closeContextMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };
    const handleScroll = () => closeContextMenu();
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [contextMenuPosition, closeContextMenu]);

  const { isSteerSubmit, showStopButton, canSubmit } = deriveCoworkPromptInputState({
    value,
    isStreaming,
    disabled,
    steerDisabled,
    attachmentCount: attachments.length,
  });
  const effectivePlaceholder = isStreaming
    ? i18nService.t(steerDisabled
      ? 'coworkSteerSandboxUnavailablePlaceholder'
      : 'coworkSteerPlaceholder')
    : placeholder;
  const enhancedContainerClass = isDraggingFiles
    ? `${containerClass} ring-2 ring-claude-accent/50 border-claude-accent/60`
    : containerClass;

  return (
    <div className="relative">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
              <div
                key={attachment.path}
                className="inline-flex items-center gap-1.5 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2.5 py-1 text-xs dark:text-claude-darkText text-claude-text max-w-full"
                title={attachment.path}
              >
                <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate max-w-[180px]">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(attachment.path)}
                  disabled={disabled || isStreaming}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('coworkAttachmentRemove')}
                  title={i18nService.t('coworkAttachmentRemove')}
                >
                  <XMarkIcon className="h-3 w-3" />
                </button>
              </div>
          ))}
        </div>
      )}
      <div
        className={enhancedContainerClass}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-claude-accent/10 text-xs font-medium text-claude-accent">
            {i18nService.t('coworkDropFileHint')}
          </div>
        )}
        {isLarge ? (
          <>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => draftFieldRef.current?.set(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onContextMenu={handleTextareaContextMenu}
              placeholder={effectivePlaceholder}
              disabled={disabled || (isStreaming && steerDisabled)}
              rows={isLarge ? 2 : 1}
              className={textareaClass}
              style={{ minHeight: `${minHeight}px` }}
            />
            <div className="flex items-center justify-between px-4 pb-2 pt-1.5">
              <fieldset
                className="flex items-center gap-2 relative border-0 p-0 m-0 min-w-0"
                disabled={disabled || isStreaming}
              >
                {showFolderSelector && (
                  <>
                    <div className="relative group">
                      <button
                        ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                        type="button"
                        onClick={() => setShowFolderMenu(!showFolderMenu)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                      >
                        <FolderIcon className="h-4 w-4" />
                        <span className="max-w-[150px] truncate text-xs">
                          {truncatePath(workingDirectory)}
                        </span>
                      </button>
                      {/* Tooltip - hidden when folder menu is open */}
                      {!showFolderMenu && (
                        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-50 max-w-[400px] break-all whitespace-nowrap">
                          {truncatePath(workingDirectory, 120)}
                        </div>
                      )}
                    </div>
                    <FolderSelectorPopover
                      isOpen={showFolderMenu}
                      onClose={() => setShowFolderMenu(false)}
                      onSelectFolder={handleFolderSelect}
                      anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                      currentFolder={workingDirectory}
                    />
                  </>
                )}
                {showModelSelector && (
                  <ModelSelector
                    dropdownDirection="up"
                    restrictToLlmId={restrictToLlmId}
                    value={onModelChange ? modelValue : null}
                    onChange={onModelChange}
                  />
                )}
                {showAttachmentButton ? (
                  <button
                    type="button"
                    onClick={handleAddFile}
                    className="flex items-center justify-center p-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                    title={i18nService.t('coworkAddFile')}
                    aria-label={i18nService.t('coworkAddFile')}
                    disabled={disabled || isStreaming}
                  >
                    <PaperClipIcon className="h-4 w-4" />
                  </button>
                ) : null}
                <SkillsButton
                  onSelectSkill={handleSelectSkill}
                  onManageSkills={handleManageSkills}
                />
                <ActiveSkillBadge />
                <KernelSelector sessionKernel={sessionKernel} />
                {showPermissionModeSelector && onPermissionModeChange && (
                  <PermissionModeSelector
                    currentMode={permissionMode ?? 'default'}
                    onModeChange={onPermissionModeChange}
                  />
                )}
              </fieldset>
              <div className="flex items-center gap-2">
                {contextUsage && (
                  <ContextUsageRing
                    usedTokens={contextUsage.usedTokens}
                    contextWindow={contextUsage.contextWindow}
                    isRealUsage={contextUsage.isRealUsage}
                    categories={contextUsage.categories}
                  />
                )}
                {showStopButton ? (
                  <button
                    type="button"
                    onClick={handleStopClick}
                    className="p-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                    aria-label={i18nService.t('stop')}
                  >
                    <StopIcon className="h-5 w-5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { void handleSubmit(); }}
                    disabled={!canSubmit}
                    className="p-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={isSteerSubmit ? i18nService.t('coworkSendSteer') : i18nService.t('sendMessage')}
                  >
                    <PaperAirplaneIcon className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => draftFieldRef.current?.set(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onContextMenu={handleTextareaContextMenu}
              placeholder={effectivePlaceholder}
              disabled={disabled || (isStreaming && steerDisabled)}
              rows={1}
              className={textareaClass}
            />

            <div className="flex items-center gap-1">
              {showAttachmentButton ? (
                <button
                  type="button"
                  onClick={handleAddFile}
                  className="flex-shrink-0 p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                  title={i18nService.t('coworkAddFile')}
                  aria-label={i18nService.t('coworkAddFile')}
                  disabled={disabled || isStreaming}
                >
                  <PaperClipIcon className="h-4 w-4" />
                </button>
              ) : null}
            </div>

            {showStopButton ? (
              <button
                type="button"
                onClick={handleStopClick}
                className="flex-shrink-0 p-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                aria-label={i18nService.t('stop')}
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { void handleSubmit(); }}
                disabled={!canSubmit}
                className="flex-shrink-0 p-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={isSteerSubmit ? i18nService.t('coworkSendSteer') : i18nService.t('sendMessage')}
              >
                <PaperAirplaneIcon className="h-4 w-4" />
              </button>
            )}
          </>
        )}
      </div>
      {showFolderRequiredWarning && (
        <div className="mt-2 text-xs text-red-500 dark:text-red-400">
          {i18nService.t('coworkSelectFolderFirst')}
        </div>
      )}
      {suggestedPrompts && suggestedPrompts.length > 0 && !disabled && (
        <div className="mt-2 flex flex-wrap gap-2">
          {suggestedPrompts.map((suggestion, index) => (
            <button
              key={`prompt-suggestion-${index}`}
              type="button"
              onClick={() => {
                draftFieldRef.current?.set(suggestion);
                textareaRef.current?.focus();
              }}
              className="inline-flex items-center gap-1 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset hover:dark:text-claude-darkText hover:text-claude-text transition-colors max-w-full text-left"
            >
              <SparklesIcon className="h-3 w-3 flex-shrink-0 text-claude-accent" />
              <span className="truncate">{suggestion}</span>
            </button>
          ))}
        </div>
      )}
      {contextMenuPosition && (
        <div
          ref={contextMenuRef}
          role="menu"
          className="fixed z-50 min-w-[176px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden py-1"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ContextMenuItem
            label={i18nService.t('contextMenuCut')}
            shortcut={isMac ? '⌘X' : 'Ctrl+X'}
            disabled={!contextMenuDerived.canCut}
            onClick={runContextMenuCut}
          />
          <ContextMenuItem
            label={i18nService.t('contextMenuCopy')}
            shortcut={isMac ? '⌘C' : 'Ctrl+C'}
            disabled={!contextMenuDerived.canCopy}
            onClick={runContextMenuCopy}
          />
          <ContextMenuItem
            label={i18nService.t('contextMenuPaste')}
            shortcut={isMac ? '⌘V' : 'Ctrl+V'}
            disabled={disabled || (isStreaming && steerDisabled)}
            onClick={runContextMenuPaste}
          />
          <div className="my-1 h-px dark:bg-claude-darkBorder bg-claude-border" />
          <ContextMenuItem
            label={i18nService.t('contextMenuSelectAll')}
            shortcut={isMac ? '⌘A' : 'Ctrl+A'}
            disabled={!contextMenuDerived.canSelectAll}
            onClick={runContextMenuSelectAll}
          />
        </div>
      )}
    </div>
  );
  }
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
