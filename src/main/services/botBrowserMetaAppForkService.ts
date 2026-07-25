import fs from 'fs';
import path from 'path';
import { METAAPP_PIN_ID_PATTERN } from './metaAppProtocol';
import type { MetaAppRecord } from '../metaAppManager';
import type { MetaAppGalleryRecord } from '@openagentinternet/agent-browser-core';
import type { BrowserCommandResult as CoreBrowserCommandResult } from '@openagentinternet/agent-browser-core';

export const METAAPP_FORK_MARKER = '.idbots-fork.json';

export type MetaAppForkMarker = {
  sourcePinId: string;
  sourceUri: string;
  title: string;
  indexFile: string;
  forkedAt: number;
};

export type ForkMetaAppResult = {
  dir: string;
  indexFile: string;
  sourcePinId: string;
  sourceUri: string;
  title: string;
};

/** Accepts metaapp://<pinId> or a bare pinId; returns normalized pinId or ''. */
export function parseMetaAppPinIdFromUri(uri: string | null | undefined): string {
  const trimmed = (uri ?? '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^metaapp:\/\/(.+)$/i);
  const candidate = (match ? match[1] : trimmed).replace(/\/+$/, '').trim();
  return METAAPP_PIN_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : '';
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'metaapp';
}

/**
 * Copy a MetaApp's source (local install under METAAPPs/, or the extracted
 * chain package in the browser cache) into the Agent's workspace so it can be
 * edited safely. Writes a `.idbots-fork.json` marker recording the provenance
 * used later for the manifest's forkedFrom field.
 */
export async function forkMetaAppToWorkspace(input: {
  pinId: string;
  workspaceDir: string;
  listMetaApps: () => Promise<MetaAppRecord[]> | MetaAppRecord[];
  resolveMetaAppPin: (pinId: string) => Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
  getMetaAppArtifactDir: (pinId: string) => Promise<{ artifactDir: string; indexFile: string } | null>;
}): Promise<ForkMetaAppResult> {
  const pinId = input.pinId.trim().toLowerCase();
  if (!METAAPP_PIN_ID_PATTERN.test(pinId)) {
    throw new Error(`Invalid MetaApp pin id: ${input.pinId}`);
  }

  let sourceDir = '';
  let indexFile = 'index.html';
  let title = '';

  const apps = await input.listMetaApps();
  const localApp = apps.find((app) => (app.sourcePinId || '').trim().toLowerCase() === pinId);
  if (localApp?.appRoot) {
    sourceDir = localApp.appRoot;
    indexFile = localApp.entry || 'index.html';
    title = localApp.name || pinId;
  } else {
    // Ensure the chain package is downloaded and extracted into the cache.
    const resolved = await input.resolveMetaAppPin(pinId);
    if (!resolved.ok) {
      throw new Error(`MetaApp not found on chain: ${pinId}`);
    }
    const artifact = await input.getMetaAppArtifactDir(pinId);
    if (!artifact) {
      throw new Error(`MetaApp source is not available locally for ${pinId}. Open it in Bot Browser first, then try again.`);
    }
    sourceDir = artifact.artifactDir;
    indexFile = artifact.indexFile || 'index.html';
    title = resolved.data.title || resolved.data.appName || pinId;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const destDir = path.join(
    input.workspaceDir,
    'metaapp-forks',
    `${slugifyTitle(title)}-${pinId.slice(0, 6)}-${stamp}`,
  );
  await fs.promises.mkdir(destDir, { recursive: true });
  await fs.promises.cp(sourceDir, destDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== METAAPP_FORK_MARKER,
  });

  const sourceUri = `metaapp://${pinId}`;
  const marker: MetaAppForkMarker = { sourcePinId: pinId, sourceUri, title, indexFile, forkedAt: Date.now() };
  await fs.promises.writeFile(
    path.join(destDir, METAAPP_FORK_MARKER),
    JSON.stringify(marker, null, 2),
    'utf-8',
  );

  return { dir: destDir, indexFile, sourcePinId: pinId, sourceUri, title };
}

/** Read the fork marker written by forkMetaAppToWorkspace, if present. */
export async function readMetaAppForkMarker(dir: string): Promise<MetaAppForkMarker | null> {
  try {
    const raw = await fs.promises.readFile(path.join(dir, METAAPP_FORK_MARKER), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MetaAppForkMarker>;
    if (typeof parsed?.sourcePinId !== 'string' || !parsed.sourcePinId) return null;
    return {
      sourcePinId: parsed.sourcePinId,
      sourceUri: typeof parsed.sourceUri === 'string' ? parsed.sourceUri : `metaapp://${parsed.sourcePinId}`,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      indexFile: typeof parsed.indexFile === 'string' && parsed.indexFile ? parsed.indexFile : 'index.html',
      forkedAt: typeof parsed.forkedAt === 'number' ? parsed.forkedAt : 0,
    };
  } catch {
    return null;
  }
}
