import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SqliteDatabase as Database } from './sqliteTypes';

export interface ProjectResource {
  path: string;
  note?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  icon?: string;
  guidelines?: string;
  sourceDir?: string;
  resources: ProjectResource[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectFormData {
  name: string;
  icon?: string | null;
  guidelines?: string | null;
  sourceDir?: string | null;
  resources?: ProjectResource[];
}

const MAX_ICON_BYTES = 200 * 1024;
const ICON_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

export class ProjectStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  private deserializeRow(values: unknown[]): ProjectRecord {
    let resources: ProjectResource[] = [];
    try {
      const parsed = JSON.parse((values[5] as string) || '[]');
      if (Array.isArray(parsed)) {
        resources = parsed
          .filter((r) => r && typeof r.path === 'string')
          .map((r) => ({ path: r.path as string, note: typeof r.note === 'string' && r.note ? r.note : undefined }));
      }
    } catch {
      // Invalid JSON, use empty list
    }

    return {
      id: values[0] as string,
      name: values[1] as string,
      icon: (values[2] as string | null) || undefined,
      guidelines: (values[3] as string | null) || undefined,
      sourceDir: (values[4] as string | null) || undefined,
      resources,
      enabled: (values[6] as number) === 1,
      createdAt: values[7] as number,
      updatedAt: values[8] as number,
    };
  }

  private validateName(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      throw new Error('Project name is required');
    }
    return trimmed;
  }

  /** Icon must be a data:image/(png|jpeg|jpg|webp|gif);base64 URL decoding to at most 200KB. */
  private validateIcon(icon: string): string {
    const match = /^data:([^;]+);base64,(.+)$/.exec(icon);
    if (!match) {
      throw new Error('Project icon must be a base64 data URL');
    }
    const mime = match[1].trim().toLowerCase();
    if (!ICON_MIME_TYPES.has(mime)) {
      throw new Error('Project icon must be a png, jpeg, jpg, webp or gif image');
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(match[2], 'base64');
    } catch {
      throw new Error('Project icon contains invalid base64 data');
    }
    if (buffer.length === 0 || buffer.length > MAX_ICON_BYTES) {
      throw new Error('Project icon must be at most 200KB');
    }
    return icon;
  }

  private validateSourceDir(sourceDir: string): string {
    if (!path.isAbsolute(sourceDir)) {
      throw new Error(`Source directory must be an absolute path: ${sourceDir}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourceDir);
    } catch {
      throw new Error(`Source directory does not exist: ${sourceDir}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Source directory must be a directory: ${sourceDir}`);
    }
    return sourceDir;
  }

  private validateResources(resources: ProjectResource[]): ProjectResource[] {
    const seen = new Set<string>();
    const validated: ProjectResource[] = [];
    for (const resource of resources || []) {
      const resourcePath = (resource?.path || '').trim();
      if (!resourcePath) continue;
      if (!path.isAbsolute(resourcePath)) {
        throw new Error(`Resource path must be absolute: ${resourcePath}`);
      }
      if (!fs.existsSync(resourcePath)) {
        throw new Error(`Resource path does not exist: ${resourcePath}`);
      }
      if (seen.has(resourcePath)) continue;
      seen.add(resourcePath);
      const note = typeof resource.note === 'string' ? resource.note.trim() : '';
      validated.push(note ? { path: resourcePath, note } : { path: resourcePath });
    }
    return validated;
  }

  private toFriendlyError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      return new Error('A project with this name already exists');
    }
    return error instanceof Error ? error : new Error(message);
  }

  listProjects(): ProjectRecord[] {
    const result = this.db.exec(
      'SELECT id, name, icon, guidelines, source_dir, resources_json, enabled, created_at, updated_at FROM projects ORDER BY created_at ASC'
    );
    if (!result[0]) return [];
    return result[0].values.map((row) => this.deserializeRow(row));
  }

  getProject(id: string): ProjectRecord | null {
    const result = this.db.exec(
      'SELECT id, name, icon, guidelines, source_dir, resources_json, enabled, created_at, updated_at FROM projects WHERE id = ?',
      [id]
    );
    if (!result[0]?.values[0]) return null;
    return this.deserializeRow(result[0].values[0]);
  }

  getProjectByName(name: string): ProjectRecord | null {
    const result = this.db.exec(
      'SELECT id, name, icon, guidelines, source_dir, resources_json, enabled, created_at, updated_at FROM projects WHERE name = ? COLLATE NOCASE',
      [(name || '').trim()]
    );
    if (!result[0]?.values[0]) return null;
    return this.deserializeRow(result[0].values[0]);
  }

  createProject(data: ProjectFormData): ProjectRecord {
    const name = this.validateName(data.name);
    const icon = data.icon ? this.validateIcon(data.icon) : null;
    const guidelines = data.guidelines?.trim() || null;
    const sourceDir = data.sourceDir ? this.validateSourceDir(data.sourceDir) : null;
    const resources = this.validateResources(data.resources || []);

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      this.db.run(
        `INSERT INTO projects (id, name, icon, guidelines, source_dir, resources_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, name, icon, guidelines, sourceDir, JSON.stringify(resources), now, now]
      );
    } catch (error) {
      throw this.toFriendlyError(error);
    }
    this.saveDb();

    return this.getProject(id)!;
  }

  /**
   * Merge-update semantics: `undefined` keeps the existing value; explicit `null`
   * (or '' for guidelines) clears icon/guidelines/sourceDir. `resources` when
   * provided replaces the whole list.
   */
  updateProject(id: string, data: Partial<ProjectFormData>): ProjectRecord | null {
    const existing = this.getProject(id);
    if (!existing) return null;

    const name = data.name !== undefined ? this.validateName(data.name) : existing.name;
    const icon =
      data.icon !== undefined ? (data.icon ? this.validateIcon(data.icon) : null) : existing.icon ?? null;
    const guidelines =
      data.guidelines !== undefined ? data.guidelines?.trim() || null : existing.guidelines ?? null;
    const sourceDir =
      data.sourceDir !== undefined
        ? data.sourceDir
          ? this.validateSourceDir(data.sourceDir)
          : null
        : existing.sourceDir ?? null;
    const resources =
      data.resources !== undefined ? this.validateResources(data.resources) : existing.resources;

    const now = Date.now();
    try {
      this.db.run(
        `UPDATE projects SET name = ?, icon = ?, guidelines = ?, source_dir = ?, resources_json = ?, updated_at = ? WHERE id = ?`,
        [name, icon, guidelines, sourceDir, JSON.stringify(resources), now, id]
      );
    } catch (error) {
      throw this.toFriendlyError(error);
    }
    this.saveDb();

    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    const existing = this.getProject(id);
    if (!existing) return false;

    this.db.run('DELETE FROM projects WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const existing = this.getProject(id);
    if (!existing) return false;

    const now = Date.now();
    this.db.run(
      'UPDATE projects SET enabled = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, now, id]
    );
    this.saveDb();
    return true;
  }
}
