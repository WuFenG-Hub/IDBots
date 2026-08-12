import type { SqliteDatabase as Database } from '../sqliteTypes';
import {
  normalizeGlobalMetaID,
  requireGlobalMetaID,
  type GlobalMetaID,
} from '../shared/globalMetaId';
import type {
  MetaIDExperienceEpisode,
  MetaIDExperienceEvidence,
  MetaIDExperienceStore,
} from '../metaidExperienceStore';
import type {
  MetaIDImpressionObservation,
  MetaIDImpressionSnapshot,
  MetaIDImpressionStore,
} from '../metaidImpressionStore';

/** Max chars of a local message excerpt rendered into the timeline. */
const MAX_EVIDENCE_TEXT_CHARS = 240;

export interface MetaIDContactSummary {
  globalMetaID: string;
  name: string | null;
  lastSeenAt: number | null;
  interactionCount: number;
  directInteractionCount: number;
}

export interface MetaIDContactEvidenceText {
  content: string | null;
  senderName: string | null;
  pinId: string | null;
  /** 'incoming' | 'outgoing' | null — only populated for private chat messages. */
  direction: string | null;
}

export interface MetaIDContactEpisodeView {
  episode: MetaIDExperienceEpisode;
  evidence: MetaIDExperienceEvidence[];
  evidenceTexts: MetaIDContactEvidenceText[];
}

export interface MetaIDContactDetail {
  observerGlobalMetaID: string;
  subjectGlobalMetaID: string;
  subjectName: string | null;
  snapshot: MetaIDImpressionSnapshot | null;
  observations: MetaIDImpressionObservation[];
  episodes: MetaIDContactEpisodeView[];
}

export interface MetaIDContactViewServiceDeps {
  db: Database;
  experienceStore: MetaIDExperienceStore;
  impressionStore: MetaIDImpressionStore;
}

/**
 * ID-anchored contact view: aggregates the MetaID experience ledger and the
 * impression system into a per-(observer, subject) view the UI can render as
 * "overall impression → related facts → related events".
 *
 * Evidence rows only store a content hash, so the local message text is
 * recovered by joining `message_id`/`pin_id` back to the private/group chat
 * message tables (source-channel dispatched to avoid id collisions).
 */
export class MetaIDContactViewService {
  private readonly db: Database;
  private readonly experienceStore: MetaIDExperienceStore;
  private readonly impressionStore: MetaIDImpressionStore;

  constructor(deps: MetaIDContactViewServiceDeps) {
    this.db = deps.db;
    this.experienceStore = deps.experienceStore;
    this.impressionStore = deps.impressionStore;
  }

  /** All GlobalMetaIDs this observer has interacted with, newest interaction first. */
  listContacts(observerGlobalMetaID: unknown): MetaIDContactSummary[] {
    const observer = requireGlobalMetaID(observerGlobalMetaID, 'observerGlobalMetaID');
    const rows = this.getAll<{
      globalmetaid: string;
      last_seen_at: number | null;
      interaction_count: number;
      direct_count: number;
    }>(`
      SELECT p.globalmetaid,
             MAX(e.started_at) AS last_seen_at,
             COUNT(DISTINCT e.id) AS interaction_count,
             COUNT(DISTINCT CASE WHEN e.episode_type = 'direct_interaction' THEN e.id END) AS direct_count
      FROM metaid_experience_participants p
      JOIN metaid_experience_episodes e ON e.id = p.episode_id
      WHERE e.owner_globalmetaid = ?
        AND p.globalmetaid IS NOT NULL
        AND p.globalmetaid != ''
        AND p.globalmetaid <> e.owner_globalmetaid
      GROUP BY p.globalmetaid
      ORDER BY last_seen_at DESC, p.globalmetaid ASC
    `, [observer]);

    return rows.map((row) => {
      const globalMetaID = normalizeGlobalMetaID(row.globalmetaid);
      if (!globalMetaID) {
        return null;
      }
      return {
        globalMetaID,
        name: this.resolveContactName(globalMetaID),
        lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
        interactionCount: Number(row.interaction_count) || 0,
        directInteractionCount: Number(row.direct_count) || 0,
      };
    }).filter((summary): summary is MetaIDContactSummary => summary !== null);
  }

  /** Full ID-anchored view: snapshot + observation history + event timeline. */
  getContactDetail(observerGlobalMetaID: unknown, subjectGlobalMetaID: unknown): MetaIDContactDetail {
    const observer = requireGlobalMetaID(observerGlobalMetaID, 'observerGlobalMetaID');
    const subject = requireGlobalMetaID(subjectGlobalMetaID, 'subjectGlobalMetaID');
    if (observer === subject) {
      throw new Error('Self impressions are not supported; pick another contact');
    }

    const episodes = this.experienceStore.listEpisodes({
      ownerGlobalMetaID: observer,
      subjectGlobalMetaID: subject,
      limit: 200,
    });

    const episodeViews: MetaIDContactEpisodeView[] = episodes.map((episode) => {
      const evidence = this.experienceStore.listEvidence(episode.id);
      return {
        episode,
        evidence,
        evidenceTexts: evidence.map((row) => this.fetchEvidenceText(episode.sourceChannel, row)),
      };
    });

    return {
      observerGlobalMetaID: observer,
      subjectGlobalMetaID: subject,
      subjectName: this.resolveContactName(subject),
      snapshot: this.impressionStore.getSnapshot(observer, subject),
      observations: this.impressionStore.listObservations({
        observerGlobalMetaID: observer,
        subjectGlobalMetaID: subject,
        limit: 50,
      }),
      episodes: episodeViews,
    };
  }

  /** Resolve a display name for a GlobalMetaID (local bot > peer name > group sender name). */
  resolveContactName(globalMetaID: unknown): string | null {
    const id = normalizeGlobalMetaID(globalMetaID);
    if (!id) {
      return null;
    }
    const localBot = this.getOne<{ name: string }>(
      'SELECT name FROM metabots WHERE globalmetaid = ? LIMIT 1',
      [id],
    );
    if (localBot?.name?.trim()) {
      return localBot.name.trim();
    }
    const peer = this.getOne<{ peer_name: string }>(`
      SELECT peer_name FROM cowork_sessions
      WHERE peer_global_metaid = ?
        AND peer_name IS NOT NULL AND peer_name != ''
      ORDER BY updated_at DESC
      LIMIT 1
    `, [id]);
    if (peer?.peer_name?.trim()) {
      return peer.peer_name.trim();
    }
    const groupSender = this.getOne<{ sender_name: string }>(`
      SELECT sender_name FROM group_chat_messages
      WHERE sender_global_metaid = ?
        AND sender_name IS NOT NULL AND sender_name != ''
      ORDER BY chain_timestamp DESC, id DESC
      LIMIT 1
    `, [id]);
    return groupSender?.sender_name?.trim() ?? null;
  }

  private fetchEvidenceText(
    sourceChannel: string,
    evidence: MetaIDExperienceEvidence,
  ): MetaIDContactEvidenceText {
    const pinId = evidence.pinId ?? null;
    if (sourceChannel === 'metaweb_private') {
      const row = this.getOne<{ content: string; from_name: string | null; pin_id: string | null; reply_pin: string | null }>(`
        SELECT content, from_name, pin_id, reply_pin
        FROM private_chat_messages
        WHERE (id = CAST(? AS INTEGER) AND ? GLOB '[0-9]*')
           OR pin_id = ?
        LIMIT 1
      `, [evidence.messageId ?? '', evidence.messageId ?? '', pinId ?? '']);
      const direction = typeof evidence.metadata?.direction === 'string' ? evidence.metadata.direction : null;
      return {
        content: row ? this.truncate(row.content) : null,
        senderName: row?.from_name?.trim() ?? null,
        pinId: row?.pin_id ?? pinId,
        direction,
      };
    }
    if (sourceChannel === 'group_task') {
      const row = this.getOne<{ content: string; sender_name: string | null; pin_id: string | null }>(`
        SELECT content, sender_name, pin_id
        FROM group_chat_messages
        WHERE (id = CAST(? AS INTEGER) AND ? GLOB '[0-9]*')
           OR pin_id = ?
        LIMIT 1
      `, [evidence.messageId ?? '', evidence.messageId ?? '', pinId ?? '']);
      return {
        content: row ? this.truncate(row.content) : null,
        senderName: row?.sender_name?.trim() ?? null,
        pinId: row?.pin_id ?? pinId,
        direction: null,
      };
    }
    // service_order and other channels keep no local message text.
    return {
      content: null,
      senderName: null,
      pinId,
      direction: null,
    };
  }

  private truncate(value: string): string {
    const text = String(value ?? '').trim();
    if (text.length <= MAX_EVIDENCE_TEXT_CHARS) {
      return text;
    }
    return `${text.slice(0, MAX_EVIDENCE_TEXT_CHARS)}…`;
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) {
      return null;
    }
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }
}
