import { createHash } from 'node:crypto';
import type { MetaIDExperienceStore } from '../metaidExperienceStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import { normalizeGlobalMetaID, type GlobalMetaID } from '../shared/globalMetaId';
import type {
  DreamImpressionPromptEvidence,
  DreamImpressionPromptSubject,
  DreamImpressionUpdate,
} from '../libs/dreamPrompt';

const MAX_SUBJECTS = 24;
const MAX_EVIDENCE_PER_SUBJECT = 32;

export interface MetaIDDreamImpressionContextDeps {
  experienceStore: MetaIDExperienceStore;
  impressionStore: MetaIDImpressionStore;
  observerGlobalMetaID: unknown;
  fromTime: number;
  toTime: number;
  maxSubjects?: number;
}

export interface MetaIDDreamImpressionApplyResult {
  accepted: number;
  created: number;
  rejected: number;
  rebuilt: number;
}

interface SubjectAccumulator {
  subjectGlobalMetaID: GlobalMetaID;
  episodeIds: string[];
  evidence: DreamImpressionPromptEvidence[];
  interactionCount: number;
  directInteractionCount: number;
  lastSeenAt: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function addUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

/** Select bounded, owner-relative evidence for the day's dream prompt. */
export function buildMetaIDDreamImpressionContext(
  input: MetaIDDreamImpressionContextDeps,
): DreamImpressionPromptSubject[] {
  const observer = normalizeGlobalMetaID(input.observerGlobalMetaID);
  if (!observer) return [];
  const accumulators = new Map<string, SubjectAccumulator>();
  const episodes = input.experienceStore.listEpisodes({
    ownerGlobalMetaID: observer,
    fromTime: input.fromTime,
    toTime: input.toTime,
    limit: 500,
  });
  for (const episode of episodes) {
    const participants = input.experienceStore.listParticipants(episode.id);
    const subjects = [...new Set(participants
      .map((participant) => normalizeGlobalMetaID(participant.globalMetaID))
      .filter((subject): subject is GlobalMetaID => Boolean(subject && subject !== observer)))];
    if (subjects.length === 0) continue;
    const evidence = input.experienceStore.listEvidence(episode.id);
    for (const subject of subjects) {
      const accumulator = accumulators.get(subject) ?? {
        subjectGlobalMetaID: subject,
        episodeIds: [],
        evidence: [],
        interactionCount: 0,
        directInteractionCount: 0,
        lastSeenAt: episode.startedAt,
      };
      addUnique(accumulator.episodeIds, episode.id);
      accumulator.interactionCount += 1;
      if (episode.episodeType === 'direct_interaction') accumulator.directInteractionCount += 1;
      accumulator.lastSeenAt = Math.max(accumulator.lastSeenAt, episode.startedAt);
      for (const item of evidence) {
        if (accumulator.evidence.length >= MAX_EVIDENCE_PER_SUBJECT) break;
        if (accumulator.evidence.some((existing) => existing.id === item.id)) continue;
        accumulator.evidence.push({
          id: item.id,
          evidenceType: item.evidenceType,
          pinId: item.pinId,
          publisherGlobalMetaID: item.publisherGlobalMetaID,
          occurredAt: item.occurredAt,
        });
      }
      accumulators.set(subject, accumulator);
    }
  }

  const limit = Math.min(MAX_SUBJECTS, Math.max(1, Math.floor(input.maxSubjects ?? MAX_SUBJECTS)));
  return [...accumulators.values()]
    .filter((subject) => subject.evidence.length > 0)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.subjectGlobalMetaID.localeCompare(right.subjectGlobalMetaID))
    .slice(0, limit)
    .map((subject) => ({
      subjectGlobalMetaID: subject.subjectGlobalMetaID,
      episodeIds: [...subject.episodeIds].sort(),
      evidenceIds: subject.evidence.map((evidence) => evidence.id).sort(),
      interactionCount: subject.interactionCount,
      directInteractionCount: subject.directInteractionCount,
      evidence: [...subject.evidence].sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id)),
      previousSnapshot: input.impressionStore.getSnapshot(observer, subject.subjectGlobalMetaID),
    }));
}

function sourceHashForSubject(
  subject: DreamImpressionPromptSubject,
  dreamDate: string,
  dreamVersion: number,
): string {
  return sha256(JSON.stringify({
    dreamDate,
    dreamVersion,
    subjectGlobalMetaID: subject.subjectGlobalMetaID,
    episodeIds: [...subject.episodeIds].sort(),
    evidenceIds: [...subject.evidenceIds].sort(),
    previousSnapshotSourceHash: subject.previousSnapshot?.summaryText ?? null,
  }));
}

/** Validate and persist LLM-produced subject updates without changing hard relationships. */
export function applyMetaIDDreamImpressionUpdates(input: {
  impressionStore: MetaIDImpressionStore;
  observerGlobalMetaID: unknown;
  dreamDate: string;
  dreamVersion: number;
  modelId?: string | null;
  subjects: DreamImpressionPromptSubject[];
  updates: DreamImpressionUpdate[];
}): MetaIDDreamImpressionApplyResult {
  const observer = normalizeGlobalMetaID(input.observerGlobalMetaID);
  if (!observer) return { accepted: 0, created: 0, rejected: input.updates.length, rebuilt: 0 };
  const subjectMap = new Map(input.subjects.map((subject) => [subject.subjectGlobalMetaID, subject]));
  const result: MetaIDDreamImpressionApplyResult = { accepted: 0, created: 0, rejected: 0, rebuilt: 0 };
  const rebuiltSubjects = new Set<string>();
  for (const update of input.updates) {
    const subjectGlobalMetaID = normalizeGlobalMetaID(update.subjectGlobalMetaId);
    const subject = subjectGlobalMetaID ? subjectMap.get(subjectGlobalMetaID) : undefined;
    const episodeIds = [...new Set(update.episodeIds.map(text).filter(Boolean))];
    const evidenceIds = [...new Set(update.evidenceIds.map(text).filter(Boolean))];
    if (!subject
      || episodeIds.length === 0
      || evidenceIds.length === 0
      || episodeIds.some((id) => !subject.episodeIds.includes(id))
      || evidenceIds.some((id) => !subject.evidenceIds.includes(id))) {
      result.rejected += 1;
      continue;
    }
    try {
      const appended = input.impressionStore.appendObservation({
        observerGlobalMetaID: observer,
        subjectGlobalMetaID,
        episodeId: episodeIds[0],
        evidenceIds,
        observationText: update.observation,
        interpretationText: update.interpretation,
        dimensions: update.dimensions,
        communicationGuidance: update.communicationGuidance,
        confidence: update.confidence,
        dreamDate: input.dreamDate,
        dreamVersion: input.dreamVersion,
        modelId: input.modelId,
        sourceHash: sourceHashForSubject(subject, input.dreamDate, input.dreamVersion),
      });
      result.accepted += 1;
      if (appended.created) result.created += 1;
      rebuiltSubjects.add(subjectGlobalMetaID);
    } catch {
      // A malformed subject must not prevent other subjects from being
      // consolidated, and the prior snapshot remains intact.
      result.rejected += 1;
    }
  }
  for (const subject of rebuiltSubjects) {
    try {
      if (input.impressionStore.rebuildSnapshot(observer, subject)) result.rebuilt += 1;
    } catch {
      // Observations remain durable and can be repaired on a later run.
    }
  }
  return result;
}
