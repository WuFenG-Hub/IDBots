import React, { useEffect, useMemo, useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface CoworkPermissionPanelProps {
  permission: CoworkPermissionRequest;
  onRespond: (result: CoworkPermissionResult) => void;
}

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

/**
 * Bottom-docked, non-blocking confirmation bar for cowork tool permissions and
 * AskUserQuestion. Replaces the full-screen centered modals (CoworkPermissionModal /
 * CoworkQuestionWizard): it stays small, does not cover the conversation with a
 * backdrop, and lets the user keep scrolling/reading the surrounding context.
 */
const CoworkPermissionPanel: React.FC<CoworkPermissionPanelProps> = ({
  permission,
  onRespond,
}) => {
  const toolInput = permission.toolInput ?? {};

  const questions = useMemo<QuestionItem[]>(() => {
    if (permission.toolName !== 'AskUserQuestion') return [];
    if (!toolInput || typeof toolInput !== 'object') return [];
    const rawQuestions = (toolInput as Record<string, unknown>).questions;
    if (!Array.isArray(rawQuestions)) return [];

    return rawQuestions
      .map((question) => {
        if (!question || typeof question !== 'object') return null;
        const record = question as Record<string, unknown>;
        const options = Array.isArray(record.options)
          ? record.options
              .map((option) => {
                if (!option || typeof option !== 'object') return null;
                const optionRecord = option as Record<string, unknown>;
                if (typeof optionRecord.label !== 'string') return null;
                return {
                  label: optionRecord.label,
                  description: typeof optionRecord.description === 'string'
                    ? optionRecord.description
                    : undefined,
                } as QuestionOption;
              })
              .filter(Boolean) as QuestionOption[]
          : [];

        if (typeof record.question !== 'string' || options.length === 0) {
          return null;
        }

        return {
          question: record.question,
          header: typeof record.header === 'string' ? record.header : undefined,
          options,
          multiSelect: Boolean(record.multiSelect),
        } as QuestionItem;
      })
      .filter(Boolean) as QuestionItem[];
  }, [permission.toolName, toolInput]);

  const isQuestionTool = questions.length > 0;

  const [expanded, setExpanded] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<number, string>>({});

  // Reset local state whenever a new permission request arrives.
  useEffect(() => {
    setExpanded(false);
    setCurrentStep(0);
    setOtherInputs({});
    const rawAnswers = (toolInput as Record<string, unknown>).answers;
    if (rawAnswers && typeof rawAnswers === 'object') {
      const initial: Record<string, string> = {};
      Object.entries(rawAnswers as Record<string, unknown>).forEach(([key, value]) => {
        if (typeof value === 'string') {
          initial[key] = value;
        }
      });
      setAnswers(initial);
    } else {
      setAnswers({});
    }
  }, [permission.requestId, toolInput]);

  const isDangerous = (() => {
    if (permission.toolName !== 'Bash') return false;
    const command = String((permission.toolInput as Record<string, unknown>)?.command ?? '');
    const dangerousPatterns = [
      /\brm\s+-rf?\b/i,
      /\bsudo\b/i,
      /\bdd\b/i,
      /\bmkfs\b/i,
      /\bformat\b/i,
      />\s*\/dev\//i,
    ];
    return dangerousPatterns.some(pattern => pattern.test(command));
  })();

  const formatToolInput = (input: Record<string, unknown>): string => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  };

  const truncate = (value: string, max = 72): string => {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine;
  };

  const buildSummary = (): string => {
    if (!toolInput || typeof toolInput !== 'object') return permission.toolName;
    switch (permission.toolName) {
      case 'Bash':
        return truncate(String(toolInput.command ?? ''));
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
        return truncate(String(toolInput.file_path ?? toolInput.notebook_path ?? ''));
      default:
        return truncate(String(toolInput.command ?? toolInput.description ?? ''));
    }
  };

  const currentQuestion = questions[currentStep];
  const totalSteps = questions.length;
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === totalSteps - 1;

  const getSelectedValues = (question: QuestionItem): string[] => {
    const rawValue = answers[question.question] ?? '';
    if (!rawValue) return [];
    if (!question.multiSelect) return [rawValue];
    return rawValue
      .split('|||')
      .map((value) => value.trim())
      .filter(Boolean);
  };

  const handleSelectOption = (question: QuestionItem, optionLabel: string) => {
    setAnswers((prev) => {
      if (!question.multiSelect) {
        return { ...prev, [question.question]: optionLabel };
      }

      const rawValue = prev[question.question] ?? '';
      const current = new Set(
        rawValue
          .split('|||')
          .map((value) => value.trim())
          .filter(Boolean)
      );
      if (current.has(optionLabel)) {
        current.delete(optionLabel);
      } else {
        current.add(optionLabel);
      }

      if (current.size === 0) {
        const next = { ...prev };
        delete next[question.question];
        return next;
      }

      return {
        ...prev,
        [question.question]: Array.from(current).join('|||'),
      };
    });
  };

  const handleOtherInputChange = (value: string) => {
    setOtherInputs((prev) => ({
      ...prev,
      [currentStep]: value,
    }));
  };

  const handlePrevious = () => {
    if (!isFirstStep) setCurrentStep((prev) => prev - 1);
  };

  const handleNext = () => {
    if (!isLastStep) setCurrentStep((prev) => prev + 1);
  };

  const handleSkip = () => {
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[currentQuestion.question];
      return next;
    });
    setOtherInputs((prev) => {
      const next = { ...prev };
      delete next[currentStep];
      return next;
    });
    if (!isLastStep) handleNext();
  };

  const isQuestionComplete = isQuestionTool
    ? questions.every((question) => {
        const answered = Boolean((answers[question.question] ?? '').trim());
        const otherIndex = questions.indexOf(question);
        const otherAnswered = Boolean(otherInputs[otherIndex]?.trim());
        return answered || otherAnswered;
      })
    : true;

  const handleApprove = () => {
    if (isQuestionTool) {
      if (!isQuestionComplete) return;
      const finalAnswers = { ...answers };
      Object.entries(otherInputs).forEach(([stepIndex, otherValue]) => {
        const question = questions[Number(stepIndex)];
        if (question && otherValue.trim()) {
          if (question.multiSelect) {
            const existing = finalAnswers[question.question]?.split('|||').map(a => a.trim()).filter(Boolean) || [];
            finalAnswers[question.question] = [...existing, otherValue.trim()].join('|||');
          } else {
            finalAnswers[question.question] = otherValue.trim();
          }
        }
      });
      onRespond({
        behavior: 'allow',
        updatedInput: {
          ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
          answers: finalAnswers,
        },
      });
      return;
    }

    onRespond({
      behavior: 'allow',
      updatedInput: toolInput && typeof toolInput === 'object' ? toolInput : {},
    });
  };

  const handleDeny = () => {
    onRespond({
      behavior: 'deny',
      message: 'Permission denied',
    });
  };

  const selectedValues = currentQuestion ? getSelectedValues(currentQuestion) : [];

  const denyButtonLabel = isQuestionTool
    ? i18nService.t('coworkDenyRequest')
    : i18nService.t('coworkDeny');
  const approveButtonLabel = isQuestionTool
    ? i18nService.t('coworkConfirmSelection')
    : i18nService.t('coworkApprove');

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center pointer-events-none px-3 pb-3">
      <div
        className={`pointer-events-auto w-full max-w-xl overflow-hidden rounded-xl border shadow-lg bg-claude-surface dark:bg-claude-darkSurface text-claude-text dark:text-claude-darkText animate-slide-up ${
          isDangerous
            ? 'border-red-400 dark:border-red-500/70'
            : 'border-claude-border dark:border-claude-darkBorder'
        }`}
      >
        {/* Header row: icon + summary + actions */}
        <div className="flex items-center gap-2 px-3 py-2">
          {isDangerous ? (
            <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0 text-red-500" />
          ) : (
            <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0 text-yellow-600 dark:text-yellow-500" />
          )}

          <div className="flex-1 min-w-0">
            {isQuestionTool ? (
              <div className="flex items-center gap-2 min-w-0">
                {totalSteps > 1 && (
                  <span className="flex-shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {currentStep + 1}/{totalSteps}
                  </span>
                )}
                <span className="truncate text-sm font-medium">
                  {currentQuestion?.question}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <code className="flex-shrink-0 text-xs font-medium px-1.5 py-0.5 rounded bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {permission.toolName}
                </code>
                <span className="truncate text-sm font-mono text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {buildSummary()}
                </span>
              </div>
            )}
          </div>

          {!isQuestionTool && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="flex-shrink-0 inline-flex items-center gap-0.5 px-2 py-1 text-xs font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            >
              {expanded ? (
                <>
                  {i18nService.t('coworkPermissionCollapse')}
                  <ChevronUpIcon className="h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  {i18nService.t('coworkPermissionDetails')}
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={handleDeny}
            className="flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {denyButtonLabel}
          </button>
          <button
            type="button"
            onClick={handleApprove}
            disabled={isQuestionTool && !isQuestionComplete}
            className={`flex-shrink-0 px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
              isDangerous
                ? 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed'
                : 'btn-idchat-primary-filled disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            {approveButtonLabel}
          </button>
        </div>

        {/* Question options (AskUserQuestion) */}
        {isQuestionTool && currentQuestion && (
          <div className="px-3 pb-2.5 space-y-2">
            {currentQuestion.header && (
              <span className="inline-block text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {currentQuestion.header}
              </span>
            )}
            <div className="flex flex-wrap gap-1.5">
              {currentQuestion.options.map((option) => {
                const isSelected = selectedValues.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => handleSelectOption(currentQuestion, option.label)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      isSelected
                        ? 'border-claude-accent bg-claude-accent/10 text-claude-text dark:text-claude-darkText'
                        : 'border-claude-border dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                    }`}
                    title={option.description}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={otherInputs[currentStep] ?? ''}
                onChange={(e) => handleOtherInputChange(e.target.value)}
                placeholder={i18nService.t('coworkQuestionWizardOther')}
                className="flex-1 px-2.5 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg placeholder:text-claude-textSecondary dark:placeholder:text-claude-darkTextSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
              />
              {totalSteps > 1 && (
                <>
                  <button
                    type="button"
                    onClick={handlePrevious}
                    disabled={isFirstStep}
                    className="flex-shrink-0 p-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-30 transition-colors"
                    title={i18nService.t('coworkQuestionWizardPrevious')}
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleNext}
                    disabled={isLastStep}
                    className="flex-shrink-0 p-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-30 transition-colors"
                    title={i18nService.t('coworkQuestionWizardNext')}
                  >
                    <ChevronRightIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleSkip}
                    className="flex-shrink-0 px-2 py-1 text-xs font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                  >
                    {i18nService.t('coworkQuestionWizardSkip')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Details (tool permission mode, expanded) */}
        {!isQuestionTool && expanded && (
          <div className="px-3 pb-3 space-y-2 border-t dark:border-claude-darkBorder border-claude-border pt-2">
            {isDangerous && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <ExclamationTriangleIcon className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-700 dark:text-red-400">
                  {i18nService.t('coworkDangerousOperation')}
                </p>
              </div>
            )}
            <label className="block text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider">
              {i18nService.t('coworkToolInput')}
            </label>
            <pre className="px-2.5 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg text-xs font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto dark:text-claude-darkText text-claude-text">
              {formatToolInput(permission.toolInput)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default CoworkPermissionPanel;
