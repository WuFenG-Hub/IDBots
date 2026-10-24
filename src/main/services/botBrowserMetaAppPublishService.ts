import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import type { MetabotStore } from '../metabotStore';
import { isPathWithin } from '../libs/runtimePaths';
import { publishMetaApp } from './metaAppOwnerService';
import { uploadMetaFile } from './metaFileUploadService';
import { METAAPP_FORK_MARKER, readMetaAppForkMarker } from './botBrowserMetaAppForkService';

export type PublishMetaAppFromDirectoryInput = {
  /** Directory to publish; must live inside the session workspace. */
  dir: string;
  workspaceDir: string;
  metabotId: number;
  title?: string;
  intro?: string;
  /** Short description of what the app is / what was changed; recorded on-chain as the AI generation prompt. */
  prompt?: string;
  /** Capability/protocol tags (e.g. simplebuzz, game); forked apps inherit the source tags when omitted. */
  tags?: string[];
  /**
   * Motion Video learning provenance (shared contract §2.4): whether the
   * builder used shared evidence and the exact exemplars/lessons/recipes
   * made available. Recorded in manifest metadata; publisher claim only.
   */
  learningMode?: 'none' | 'exemplars' | 'lessons' | 'combined';
  learnedFrom?: string[];
  metabotStore: MetabotStore;
  /** Native confirmation gate; must resolve true before any chain write happens. */
  confirmPublish: (details: {
    title: string;
    appDir: string;
    entryFile: string;
    zipBytes: number;
    forkedFrom: string | null;
  }) => Promise<boolean>;
  /** Test seams; production uses the real services. */
  deps?: {
    uploadMetaFile?: typeof uploadMetaFile;
    publishMetaApp?: typeof publishMetaApp;
  };
};

export type PublishMetaAppFromDirectoryResult = {
  pinId: string;
  metaappUri: string;
  totalCost: number;
  /** Whether the package ships an APP.md self-description at its root. */
  hasAppDoc: boolean;
};

async function addDirectoryToZip(zip: AdmZip, absDir: string, prefix: string): Promise<void> {
  const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === METAAPP_FORK_MARKER) continue;
    const abs = path.join(absDir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, abs, rel);
    } else if (entry.isFile()) {
      zip.addFile(rel, await fs.promises.readFile(abs));
    }
  }
}

/**
 * Package a workspace MetaApp directory as a zip, upload it as a metafile, and
 * publish a /protocols/metaapp pin under the user's MetaBot. Fork provenance
 * (`.idbots-fork.json`) becomes the manifest's `forkedFrom`; the modification
 * summary becomes `prompt`. Requires explicit user confirmation first.
 */
export async function publishMetaAppFromDirectory(
  input: PublishMetaAppFromDirectoryInput,
): Promise<PublishMetaAppFromDirectoryResult> {
  const dir = path.resolve(input.dir);
  const workspace = path.resolve(input.workspaceDir);
  if (dir !== workspace && !isPathWithin(workspace, dir)) {
    throw new Error(`Publish directory must be inside the session workspace: ${input.dir}`);
  }
  const stat = await fs.promises.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Directory not found: ${dir}`);
  }

  const marker = await readMetaAppForkMarker(dir);
  const entryFile = marker?.indexFile || 'index.html';
  const entryStat = await fs.promises.stat(path.join(dir, entryFile)).catch(() => null);
  if (!entryStat?.isFile()) {
    throw new Error(`Entry file not found: ${path.join(dir, entryFile)}`);
  }
  const hasAppDoc = await fs.promises.stat(path.join(dir, 'APP.md')).then((stat) => stat.isFile()).catch(() => false);

  // Motion-video learning provenance (shared contract §2.4). Validated
  // strictly at the service layer BEFORE any side effect (zip, confirmation,
  // upload, chain write) — the Agent tool's zod is not the last line of
  // defense: pin ids must be the full 64-hex + index form inside a
  // metaapp:// or pin:// URI, invalid values are rejected (never silently
  // trimmed or truncated), and the learningMode enum is re-checked.
  const LEARNING_MODES = new Set(['none', 'exemplars', 'lessons', 'combined']);
  const LEARNED_FROM_URI_PATTERN = /^(?:metaapp|pin):\/\/[0-9a-f]{64}i\d+$/iu;
  const MAX_LEARNED_FROM_URIS = 64;
  if (input.learningMode != null && !LEARNING_MODES.has(input.learningMode)) {
    throw new Error(`Invalid learningMode "${input.learningMode}"; expected none, exemplars, lessons, or combined.`);
  }
  if (input.learnedFrom != null && !Array.isArray(input.learnedFrom)) {
    throw new Error('learnedFrom must be an array of metaapp:// or pin:// URIs.');
  }
  const learnedFromUris = ((input.learnedFrom as unknown[] | undefined) ?? [])
    .map((uri) => String(uri ?? '').trim());
  if (learnedFromUris.length > MAX_LEARNED_FROM_URIS) {
    throw new Error(`learnedFrom accepts at most ${MAX_LEARNED_FROM_URIS} URIs; got ${learnedFromUris.length}.`);
  }
  const invalidUris = learnedFromUris.filter((uri) => !LEARNED_FROM_URI_PATTERN.test(uri));
  if (invalidUris.length) {
    throw new Error(
      `Invalid learnedFrom URI(s): ${invalidUris.slice(0, 3).map((uri) => JSON.stringify(uri)).join(', ')}`
      + `${invalidUris.length > 3 ? ` (and ${invalidUris.length - 3} more)` : ''}.`
      + ' Each entry must be a full metaapp:// or pin:// URI with a 64-hex-character pin id.',
    );
  }
  const manifestMetadata: Record<string, unknown> = {};
  if (input.learningMode) {
    manifestMetadata.learningMode = input.learningMode;
  }
  if (learnedFromUris.length) {
    manifestMetadata.learnedFrom = learnedFromUris;
  }

  const title = (input.title ?? '').trim() || marker?.title || path.basename(dir);
  const appName = title.slice(0, 60);

  const zip = new AdmZip();
  await addDirectoryToZip(zip, dir, '');
  const zipBuffer = zip.toBuffer();

  const confirmed = await input.confirmPublish({
    title,
    appDir: dir,
    entryFile,
    zipBytes: zipBuffer.length,
    forkedFrom: marker?.sourcePinId ?? null,
  });
  if (!confirmed) {
    throw new Error('user_cancelled: publish was cancelled by the user.');
  }

  const upload = await (input.deps?.uploadMetaFile ?? uploadMetaFile)(input.metabotStore, {
    metabotId: input.metabotId,
    data: zipBuffer,
    dataFileName: `${appName}.zip`,
    contentType: 'application/zip',
  });
  const zipPinId = String(upload.pinId || '').trim().toLowerCase();
  if (!zipPinId) {
    throw new Error('Metafile upload did not return a pin id.');
  }

  const result = await (input.deps?.publishMetaApp ?? publishMetaApp)(input.metabotStore, input.metabotId, {
    title,
    appName,
    prompt: (input.prompt ?? '').trim() || undefined,
    forkedFrom: marker?.sourcePinId ?? undefined,
    intro: (input.intro ?? '').trim() || undefined,
    runtime: 'browser',
    version: '1.0.0',
    contentType: 'text/html',
    content: `metafile://${zipPinId}.zip`,
    indexFile: entryFile,
    codeType: 'application/zip',
    tags: input.tags?.length ? input.tags : marker?.tags,
    ...(Object.keys(manifestMetadata).length ? { metadata: manifestMetadata } : {}),
  }, { confirm: true });

  return {
    pinId: result.pinId,
    metaappUri: result.metaappUri,
    totalCost: result.chainWrite.totalCost,
    hasAppDoc,
  };
}
