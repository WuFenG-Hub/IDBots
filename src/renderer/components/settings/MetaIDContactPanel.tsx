import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import type {
  CoworkMetaIDContactDetail,
  CoworkMetaIDContactEpisodeView,
  CoworkMetaIDImpressionObservation,
  CoworkUserMemoryEntry,
} from '../../types/cowork';

interface MetaIDContactPanelProps {
  detail: CoworkMetaIDContactDetail;
  /** Contact-scope memory entries shown as the "related facts" layer. */
  facts: CoworkUserMemoryEntry[];
  factsLoading: boolean;
  onEditFact: (entry: CoworkUserMemoryEntry) => void;
  onDeleteFact: (entry: CoworkUserMemoryEntry) => void;
}

function formatTimestamp(timestamp: number | null): string {
  if (!Number.isFinite(timestamp as number) || (timestamp as number) <= 0) return '-';
  try {
    return new Date(timestamp as number).toLocaleString();
  } catch {
    return '-';
  }
}

function getChannelLabel(sourceChannel: string): string {
  if (sourceChannel === 'metaweb_private') return i18nService.t('metaidContactChannelPrivate');
  if (sourceChannel === 'group_task') return i18nService.t('metaidContactChannelGroupTask');
  if (sourceChannel === 'service_order') return i18nService.t('metaidContactChannelOrder');
  return i18nService.t('metaidContactChannelOther');
}

const CHANNEL_PILL_CLASS: Record<string, string> = {
  metaweb_private: 'dark:border-claude-darkBorder border-claude-border',
  group_task: 'border-sky-500/50 text-sky-600 dark:text-sky-400',
  service_order: 'border-violet-500/50 text-violet-600 dark:text-violet-400',
};

function EpisodeRow(props: {
  episodeView: CoworkMetaIDContactEpisodeView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { episodeView, expanded, onToggle } = props;
  const { episode, evidence, evidenceTexts } = episodeView;
  const pillClass = CHANNEL_PILL_CLASS[episode.sourceChannel] ?? CHANNEL_PILL_CLASS.metaweb_private;
  const firstText = evidenceTexts.find((text) => text.content?.trim());
  const evidenceCount = evidence.length;

  return (
    <div className="px-3 py-2 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-2 text-left"
      >
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 ${pillClass}`}>
              {getChannelLabel(episode.sourceChannel)}
            </span>
            <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
              {episode.status}
            </span>
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {formatTimestamp(episode.startedAt)}
            </span>
            {episode.sourceChannel === 'group_task' && episode.taskId && (
              <span className="dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                #{episode.taskId}
              </span>
            )}
            {episode.sourceChannel === 'service_order' && episode.orderId && (
              <span className="dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 truncate max-w-[160px]">
                {episode.orderId}
              </span>
            )}
          </div>
          {!expanded && firstText?.content && (
            <div className="dark:text-claude-darkText text-claude-text break-words line-clamp-2 opacity-90">
              {firstText.content}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className="text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {`${evidenceCount} · ${expanded ? i18nService.t('metaidContactEventClose') : i18nService.t('metaidContactEventOpen')}`}
          </span>
          <svg
            className={`h-3.5 w-3.5 transition-transform dark:text-claude-darkTextSecondary text-claude-textSecondary ${expanded ? 'rotate-180' : ''}`}
            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 border-t dark:border-claude-darkBorder border-claude-border pt-2">
          {evidenceTexts.map((text, index) => {
            const evidenceRow = evidence[index];
            return (
              <div key={evidenceRow?.id ?? index} className="space-y-0.5">
                {text.content ? (
                  <div className="dark:text-claude-darkText text-claude-text break-words whitespace-pre-wrap">
                    {text.content}
                  </div>
                ) : (
                  <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary italic">
                    {evidenceRow?.evidenceType ?? '-'}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                  {text.senderName && <span>{text.senderName}</span>}
                  {text.direction === 'incoming' && <span>↓</span>}
                  {text.direction === 'outgoing' && <span>↑</span>}
                  <span>{formatTimestamp(evidenceRow?.occurredAt ?? null)}</span>
                  {text.pinId && (
                    <span className="font-mono truncate max-w-[220px]" title={text.pinId}>
                      {text.pinId}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ObservationRow(props: {
  observation: CoworkMetaIDImpressionObservation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { observation, expanded, onToggle } = props;
  return (
    <div className="px-3 py-2 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-2 text-left"
      >
        <div className="flex-1 min-w-0 space-y-1">
          <div className="dark:text-claude-darkText text-claude-text break-words">
            {observation.interpretationText || observation.observationText}
          </div>
          <div className="text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {observation.dreamDate} · {formatTimestamp(observation.createdAt)}
          </div>
        </div>
        <svg
          className={`h-3.5 w-3.5 transition-transform dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 border-t dark:border-claude-darkBorder border-claude-border pt-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <div className="break-words whitespace-pre-wrap">{observation.observationText}</div>
          {observation.communicationGuidance && (
            <div className="break-words whitespace-pre-wrap opacity-90">
              {observation.communicationGuidance}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ID-anchored contact panel: overall impression → observation history →
 * related facts → related event timeline for one (observer, subject) pair.
 */
const MetaIDContactPanel: React.FC<MetaIDContactPanelProps> = ({
  detail,
  facts,
  factsLoading,
  onEditFact,
  onDeleteFact,
}) => {
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<string | null>(null);
  const [expandedObservationId, setExpandedObservationId] = useState<string | null>(null);
  const { snapshot, observations, episodes } = detail;

  return (
    <div className="space-y-4">
      {/* Layer 1: overall impression */}
      <div className="rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('metaidContactOverallImpression')}
          </span>
          {snapshot && (
            <span className="text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {`${snapshot.interactionCount} ${i18nService.t('metaidContactInteractionCount')} · ${i18nService.t('metaidContactFirstSeen')} ${formatTimestamp(snapshot.firstSeenAt)}`}
            </span>
          )}
        </div>
        {!snapshot ? (
          <div className="mt-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('metaidContactNoImpression')}
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <div className="text-sm dark:text-claude-darkText text-claude-text break-words whitespace-pre-wrap">
              {snapshot.summaryText}
            </div>
            {snapshot.styleDescriptors.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                  {i18nService.t('metaidContactStyle')}:
                </span>
                {snapshot.styleDescriptors.map((descriptor) => (
                  <span key={descriptor} className="rounded-full border px-2 py-0.5 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {descriptor}
                  </span>
                ))}
              </div>
            )}
            {snapshot.cooperationContext && (
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">
                {`${i18nService.t('metaidContactCooperation')}: ${snapshot.cooperationContext}`}
              </div>
            )}
            {snapshot.communicationGuidance && (
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">
                {`${i18nService.t('metaidContactCommunication')}: ${snapshot.communicationGuidance}`}
              </div>
            )}
            {snapshot.uncertaintyText && (
              <div className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 italic break-words">
                {`${i18nService.t('metaidContactUncertainty')}: ${snapshot.uncertaintyText}`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Layer 2: observation history */}
      {observations.length > 0 && (
        <div className="rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
          <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
            {`${i18nService.t('metaidContactObservationHistory')} (${observations.length})`}
          </span>
          <div className="mt-2 max-h-[240px] overflow-auto divide-y dark:divide-claude-darkBorder divide-claude-border rounded-lg border dark:border-claude-darkBorder border-claude-border">
            {observations.map((observation) => (
              <ObservationRow
                key={observation.id}
                observation={observation}
                expanded={expandedObservationId === observation.id}
                onToggle={() => setExpandedObservationId(
                  expandedObservationId === observation.id ? null : observation.id,
                )}
              />
            ))}
          </div>
        </div>
      )}

      {/* Layer 3: related facts */}
      <div className="rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
        <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
          {`${i18nService.t('metaidContactFacts')} (${facts.length})`}
        </span>
        <div className="mt-2 max-h-[300px] overflow-auto divide-y dark:divide-claude-darkBorder divide-claude-border rounded-lg border dark:border-claude-darkBorder border-claude-border">
          {factsLoading ? (
            <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          ) : facts.length === 0 ? (
            <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkMemoryEmpty')}
            </div>
          ) : (
            facts.map((entry) => (
              <div key={entry.id} className="px-3 py-2 text-xs flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="dark:text-claude-darkText text-claude-text break-words">
                    {entry.text}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                    {entry.usageClass && <span>{getUsageClassLabel(entry.usageClass)}</span>}
                    <span>{formatTimestamp(entry.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => onEditFact(entry)}
                    className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    {i18nService.t('edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteFact(entry)}
                    className="rounded border px-2 py-1 text-red-500 dark:border-claude-darkBorder border-claude-border hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    {i18nService.t('delete')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Layer 4: event timeline */}
      <div className="rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
        <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
          {`${i18nService.t('metaidContactEvents')} (${episodes.length})`}
        </span>
        <div className="mt-2 max-h-[400px] overflow-auto divide-y dark:divide-claude-darkBorder divide-claude-border rounded-lg border dark:border-claude-darkBorder border-claude-border">
          {episodes.length === 0 ? (
            <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metaidContactNoEvents')}
            </div>
          ) : (
            episodes.map((episodeView) => (
              <EpisodeRow
                key={episodeView.episode.id}
                episodeView={episodeView}
                expanded={expandedEpisodeId === episodeView.episode.id}
                onToggle={() => setExpandedEpisodeId(
                  expandedEpisodeId === episodeView.episode.id ? null : episodeView.episode.id,
                )}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

function getUsageClassLabel(usageClass: CoworkUserMemoryEntry['usageClass']): string {
  if (usageClass === 'self_identity') return i18nService.t('coworkMemorySelfIdentity');
  if (usageClass === 'profile_fact') return i18nService.t('coworkMemoryUsageProfileFact');
  if (usageClass === 'preference') return i18nService.t('coworkMemoryUsagePreference');
  if (usageClass === 'operational_preference') return i18nService.t('coworkMemoryUsageOperationalPreference');
  if (usageClass === 'work_review') return i18nService.t('coworkMemoryUsageWorkReview');
  if (usageClass === 'value_boundary') return i18nService.t('coworkMemoryUsageValueBoundary');
  return usageClass ?? '-';
}

export default MetaIDContactPanel;
