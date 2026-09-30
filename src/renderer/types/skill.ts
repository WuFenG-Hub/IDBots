// Official skill from MetaWeb (sync status)
export type OfficialSkillStatus = 'download' | 'update' | 'installed' | 'conflict';

export interface OfficialSkillItem {
  name: string;
  remoteVersion: string;
  skillFileUri: string;
  remoteCreator: string;
  description?: string;
  status: OfficialSkillStatus;
  localVersion?: string;
  localCreator?: string;
}

// Skill type definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;       // Whether visible in popover
  isOfficial: boolean;    // "官方" badge
  isBuiltIn: boolean;     // Bundled with app, cannot be deleted
  updatedAt: number;      // Timestamp
  prompt: string;         // System prompt content
  skillPath: string;      // Absolute path to SKILL.md
}

// Assignment-model enrichment (skills:list):
// - 'bundled': shipped with IDBots, implicitly visible to every bot
// - 'global':  external skill the owner shared with all bots
// - 'library': external skill available only to bots it is assigned to
export type SkillScopeLabel = 'bundled' | 'global' | 'library';

export interface SkillWithAssignment extends Skill {
  scope?: SkillScopeLabel;
  assignedMetabotIds?: number[];
}

/**
 * One entry of the Skills page "missing from disk" banner: the skill is still
 * authorized (global scope and/or assigned to bots) but its directory is gone.
 * `sourceUri` (when recorded at install time) enables one-click reinstall.
 */
export interface MissingSkillEntry {
  id: string;
  scope: 'library' | 'global';
  assignedMetabotIds: number[];
  sourceUri: string | null;
}
