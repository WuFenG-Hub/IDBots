/**
 * Skill / MetaApp package install service.
 *
 * Backs the skill_tool actions: extract_metaapp (unzip a MetaApp pin and
 * return APP.md), install_skill (zip / github / skills.sh / npm → global
 * SKILLs/<name>/), and list_installed_skills.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import yaml from 'js-yaml';
import AdmZip from 'adm-zip';
import { parseMetaAppPinIdFromUri } from './botBrowserMetaAppForkService';
import { parseProtocolPinContent } from './protocolPinContent';
import {
  downloadMetafileBytes,
  extractMetafilePinId,
  isZipPayload,
  type DownloadBytesOptions,
} from '../libs/metafileDownload';

export const MAX_SKILL_PACKAGE_BYTES = 4 * 1024 * 1024;
export const INVALID_SKILL_PACKAGE_MESSAGE = 'not a valid skill package';
export const NOT_A_ZIP_REASON = 'not-a-zip';

const SKILL_FILE_NAME = 'SKILL.md';
const APP_FILE_NAME = 'APP.md';
const SKILLS_CONFIG_FILE = 'skills.config.json';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type ExtractMetaAppResult =
  | {
      ok: true;
      files: string[];
      appMd: string | null;
      extractedDir: string;
    }
  | {
      ok: false;
      reason: string;
    };

export type InstallSkillSource = {
  zip?: string;
  github?: string;
  'skills.sh'?: string;
  npm?: string;
};

export type InstallSkillResult =
  | {
      ok: true;
      name: string;
      version: string;
      dest: string;
    }
  | {
      ok: false;
      error: string;
    };

export type InstalledSkillInfo = {
  name: string;
  version: string;
};

export type DownloadedBytes = {
  buffer: Buffer;
  contentType: string;
};

export type SkillInstallDeps = {
  fetchPin: (pinId: string) => Promise<Record<string, unknown>>;
  downloadBytes?: (source: string, options?: DownloadBytesOptions) => Promise<DownloadedBytes>;
  getSkillsRoot: () => string;
  reloadSkills?: () => void;
  workspaceDir: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

type SkillsConfig = {
  version?: number;
  description?: string;
  defaults: Record<string, {
    order?: number;
    enabled?: boolean;
    version?: string;
    'creator-metaid'?: string;
    installedAt?: number;
  }>;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFolderName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

function assertPackageSize(buffer: Buffer): void {
  if (buffer.length > MAX_SKILL_PACKAGE_BYTES) {
    throw new Error(
      `Skill package exceeds the 4MB size limit (${buffer.length} bytes).`,
    );
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseSkillFrontmatter(raw: string): { name: string; version: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = normalized.match(FRONTMATTER_RE);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = yaml.load(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      frontmatter = {};
    }
  }
  return {
    name: text(frontmatter.name),
    version: text(frontmatter.version) || '0',
  };
}

function listFilesRelative(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === '__MACOSX') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  files.sort();
  return files;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  const entries = fs.readdirSync(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__MACOSX' || entry.name === '.DS_Store') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

function safeExtractZip(buffer: Buffer, destination: string): void {
  const zip = new AdmZip(buffer);
  for (const entry of zip.getEntries()) {
    const rawName = String(entry.entryName || '').replace(/\\/g, '/');
    if (!rawName) continue;
    const normalized = path.posix.normalize(rawName);
    if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error(`Zip contains unsafe path: ${rawName}`);
    }
    const destinationPath = path.resolve(destination, ...normalized.split('/'));
    if (!isInside(path.resolve(destination), destinationPath)) {
      throw new Error(`Zip entry escapes destination: ${rawName}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(destinationPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, entry.getData());
  }
}

/**
 * Minimal ustar extractor for npm pack tarballs (`package/...`).
 * Rejects `..` and absolute paths.
 */
export function extractTarBuffer(buffer: Buffer, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '').trim();
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '').trim();
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeOctal, 8) || 0;
    const typeFlag = header[156];
    const type = typeFlag ? String.fromCharCode(typeFlag) : '0';
    offset += 512;
    if (!fullName) {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const normalized = path.posix.normalize(fullName.replace(/\\/g, '/'));
    if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error(`Tar contains unsafe path: ${fullName}`);
    }
    const destinationPath = path.resolve(destination, ...normalized.split('/'));
    if (!isInside(path.resolve(destination), destinationPath)) {
      throw new Error(`Tar entry escapes destination: ${fullName}`);
    }
    if (type === '5' || normalized.endsWith('/')) {
      fs.mkdirSync(destinationPath, { recursive: true });
    } else if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, buffer.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

export function extractTarGzBuffer(buffer: Buffer, destination: string): void {
  const unzipped = zlib.gunzipSync(buffer);
  extractTarBuffer(unzipped, destination);
}

/**
 * Locate the skill root: SKILL.md at the extracted root, or inside a single
 * wrapping directory (GitHub archive / npm `package/` layout). Deep searches
 * are intentionally not performed — a legal skill package has SKILL.md at
 * its (possibly wrapped) root.
 */
export function findSkillRoot(extractedDir: string): string | null {
  const skillAtRoot = path.join(extractedDir, SKILL_FILE_NAME);
  if (fs.existsSync(skillAtRoot)) return extractedDir;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(extractedDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((entry) => (
    entry.isDirectory()
    && entry.name !== '__MACOSX'
    && !entry.name.startsWith('.')
  ));
  if (dirs.length === 1) {
    const nested = path.join(extractedDir, dirs[0].name);
    if (fs.existsSync(path.join(nested, SKILL_FILE_NAME))) return nested;
  }
  return null;
}

function writeSkillConfig(root: string, name: string, version: string, now: number): void {
  const configPath = path.join(root, SKILLS_CONFIG_FILE);
  let config: SkillsConfig = { version: 1, defaults: {} };
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SkillsConfig;
      if (parsed && typeof parsed.defaults === 'object') {
        config = parsed;
      }
    } catch {
      config = { version: 1, defaults: {} };
    }
  }
  const existing = config.defaults[name] ?? {};
  config.defaults[name] = {
    ...existing,
    version,
    installedAt: now,
    enabled: existing.enabled ?? true,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function downloadSource(
  deps: SkillInstallDeps,
  source: string,
  options?: DownloadBytesOptions,
): Promise<DownloadedBytes> {
  if (deps.downloadBytes) {
    return deps.downloadBytes(source, options);
  }
  const downloaded = await downloadMetafileBytes(source, {
    fetchImpl: deps.fetchImpl,
    requireZip: options?.requireZip,
  });
  return { buffer: downloaded.buffer, contentType: downloaded.contentType };
}

function githubArchiveCandidates(owner: string, repo: string, ref?: string): string[] {
  const encodedRef = ref ? encodeURIComponent(ref) : '';
  const urls: string[] = [];
  if (encodedRef) {
    urls.push(
      `https://github.com/${owner}/${repo}/archive/refs/heads/${encodedRef}.zip`,
      `https://github.com/${owner}/${repo}/archive/refs/tags/${encodedRef}.zip`,
      `https://github.com/${owner}/${repo}/archive/${encodedRef}.zip`,
    );
  }
  urls.push(
    `https://api.github.com/repos/${owner}/${repo}/zipball${encodedRef ? `/${encodedRef}` : ''}`,
  );
  return urls;
}

function parseGithubSource(source: string): { owner: string; repo: string; ref?: string; subpath?: string } | null {
  const trimmed = source.trim();
  const ownerRepo = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (ownerRepo) {
    return { owner: ownerRepo[1], repo: ownerRepo[2].replace(/\.git$/i, '') };
  }
  try {
    const parsed = new URL(trimmed);
    if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
      return null;
    }
    const segments = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const [owner, repoRaw, mode, ref, ...rest] = segments;
    const repo = repoRaw.replace(/\.git$/i, '');
    if (mode === 'tree' || mode === 'blob') {
      if (!ref) return { owner, repo };
      const subpath = rest.join('/');
      return {
        owner,
        repo,
        ref: decodeURIComponent(ref),
        subpath: subpath ? decodeURIComponent(subpath) : undefined,
      };
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

async function extractArchiveToDir(
  buffer: Buffer,
  contentType: string,
  dest: string,
): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  if (isZipPayload(buffer, contentType)) {
    safeExtractZip(buffer, dest);
    return;
  }
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (isGzip || /gzip|x-tar|octet-stream/i.test(contentType)) {
    extractTarGzBuffer(buffer, dest);
    return;
  }
  throw new Error(INVALID_SKILL_PACKAGE_MESSAGE);
}

async function downloadGithubArchive(
  deps: SkillInstallDeps,
  source: { owner: string; repo: string; ref?: string },
): Promise<DownloadedBytes> {
  const urls = githubArchiveCandidates(source.owner, source.repo, source.ref);
  let lastError = '';
  for (const url of urls) {
    try {
      const downloaded = await downloadSource(deps, url);
      if (downloaded.buffer.length === 0) {
        lastError = `empty archive from ${url}`;
        continue;
      }
      return downloaded;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`GitHub archive download failed for ${source.owner}/${source.repo}: ${lastError || 'no usable URL'}`);
}

async function resolveSkillsShPackage(
  deps: SkillInstallDeps,
  name: string,
): Promise<{ github?: string; url?: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('skills.sh package name is empty.');
  if (/^https?:\/\//iu.test(trimmed)) return { url: trimmed };
  if (parseGithubSource(trimmed)) return { github: trimmed };

  const lookupUrl = `https://skills.sh/${encodeURIComponent(trimmed)}`;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(`Cannot resolve skills.sh package "${trimmed}" without fetch.`);
  }
  const response = await fetchImpl(lookupUrl, { redirect: 'manual', method: 'GET' });
  const location = response.headers.get('location') || '';
  if (/github\.com/i.test(location)) {
    return { github: location };
  }
  if (/^https?:\/\//iu.test(location)) {
    return { url: location };
  }
  if (response.ok) {
    const body = await response.text().catch(() => '');
    const githubMatch = body.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
    if (githubMatch) return { github: githubMatch[0] };
  }
  throw new Error(`Unknown skills.sh package: ${trimmed}`);
}

async function downloadNpmPackage(deps: SkillInstallDeps, name: string): Promise<DownloadedBytes> {
  const pkg = name.trim();
  if (!pkg) throw new Error('npm package name is empty.');
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to install npm skills.');
  }
  const encoded = pkg.split('/').map((part) => encodeURIComponent(part)).join('/');
  const metaUrl = `https://registry.npmjs.org/${encoded}/latest`;
  const metaRes = await fetchImpl(metaUrl, { headers: { accept: 'application/json' } });
  if (!metaRes.ok) {
    throw new Error(`npm registry lookup failed for ${pkg}: HTTP ${metaRes.status}`);
  }
  const meta = await metaRes.json() as { dist?: { tarball?: string } };
  const tarball = text(meta?.dist?.tarball);
  if (!tarball) {
    throw new Error(`npm package ${pkg} has no tarball URL.`);
  }
  return downloadSource(deps, tarball);
}

function sourceCount(input: InstallSkillSource): number {
  return [input.zip, input.github, input['skills.sh'], input.npm]
    .filter((value) => text(value))
    .length;
}

function cleanupDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function placeSkillFromExtracted(
  extractedDir: string,
  skillsRoot: string,
  now: number,
  subpath?: string,
): { name: string; version: string; dest: string } {
  const scoped = subpath
    ? path.resolve(extractedDir, ...subpath.split('/').filter(Boolean))
    : extractedDir;
  if (!isInside(path.resolve(extractedDir), scoped) && scoped !== path.resolve(extractedDir)) {
    throw new Error(`Path "${subpath}" is outside the extracted archive.`);
  }
  const scopedRoot = fs.existsSync(scoped) && fs.statSync(scoped).isFile()
    && path.basename(scoped) === SKILL_FILE_NAME
    ? path.dirname(scoped)
    : scoped;
  const skillRoot = findSkillRoot(scopedRoot);
  if (!skillRoot) {
    throw new Error(INVALID_SKILL_PACKAGE_MESSAGE);
  }
  const raw = fs.readFileSync(path.join(skillRoot, SKILL_FILE_NAME), 'utf8');
  const parsed = parseSkillFrontmatter(raw);
  const name = normalizeFolderName(parsed.name || path.basename(skillRoot));
  const dest = path.join(skillsRoot, name);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  copyDir(skillRoot, dest);
  writeSkillConfig(skillsRoot, name, parsed.version, now);
  return { name, version: parsed.version, dest };
}

function readMetaAppContentRef(pin: Record<string, unknown>): { content: string; contentType: string } {
  const parsed = parseProtocolPinContent(pin) ?? {};
  const content = text(parsed.content) || text(pin.content);
  const contentType = text(parsed.contentType)
    || text(pin.contentType)
    || text(pin.contentTypeDetect);
  return { content, contentType };
}

export async function extractMetaApp(
  pinIdOrUri: string,
  deps: SkillInstallDeps,
): Promise<ExtractMetaAppResult> {
  const pinId = parseMetaAppPinIdFromUri(pinIdOrUri) || extractMetafilePinId(pinIdOrUri) || text(pinIdOrUri);
  if (!pinId) {
    return { ok: false, reason: 'invalid-pin' };
  }

  let pin: Record<string, unknown>;
  try {
    pin = await deps.fetchPin(pinId);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const { content, contentType } = readMetaAppContentRef(pin);
  if (!content) {
    return { ok: false, reason: NOT_A_ZIP_REASON };
  }

  let downloaded: DownloadedBytes;
  try {
    downloaded = await downloadSource(deps, content, { requireZip: true });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const effectiveType = downloaded.contentType || contentType;
  if (!isZipPayload(downloaded.buffer, effectiveType)) {
    return { ok: false, reason: NOT_A_ZIP_REASON };
  }

  const workspaceDir = path.resolve(deps.workspaceDir || os.tmpdir());
  const extractedDir = path.join(workspaceDir, '.idbots-extract', pinId);
  cleanupDir(extractedDir);
  fs.mkdirSync(extractedDir, { recursive: true });
  try {
    safeExtractZip(downloaded.buffer, extractedDir);
  } catch (error) {
    cleanupDir(extractedDir);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const skillLikeRoot = findSkillRoot(extractedDir) || extractedDir;
  const appMdPath = path.join(skillLikeRoot, APP_FILE_NAME);
  const nestedAppMd = path.join(extractedDir, APP_FILE_NAME);
  let appMd: string | null = null;
  if (fs.existsSync(appMdPath)) {
    appMd = fs.readFileSync(appMdPath, 'utf8');
  } else if (fs.existsSync(nestedAppMd)) {
    appMd = fs.readFileSync(nestedAppMd, 'utf8');
  } else {
    // One wrapping folder that is not a skill (MetaApp zip with APP.md inside).
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX' && !entry.name.startsWith('.'));
    if (entries.length === 1) {
      const wrapped = path.join(extractedDir, entries[0].name, APP_FILE_NAME);
      if (fs.existsSync(wrapped)) {
        appMd = fs.readFileSync(wrapped, 'utf8');
      }
    }
  }

  return {
    ok: true,
    files: listFilesRelative(extractedDir),
    appMd,
    extractedDir,
  };
}

export async function installSkill(
  input: InstallSkillSource,
  deps: SkillInstallDeps,
): Promise<InstallSkillResult> {
  if (sourceCount(input) !== 1) {
    return {
      ok: false,
      error: 'install_skill requires exactly one of zip, github, skills.sh, or npm.',
    };
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-install-'));
  const now = deps.now?.() ?? Date.now();
  try {
    let downloaded: DownloadedBytes | null = null;
    let githubSubpath: string | undefined;
    const zipRef = text(input.zip);
    const githubRef = text(input.github);
    const skillsShRef = text(input['skills.sh']);
    const npmRef = text(input.npm);

    if (zipRef) {
      if (fs.existsSync(zipRef)) {
        const stat = fs.statSync(zipRef);
        if (stat.isDirectory()) {
          const placed = placeSkillFromExtracted(zipRef, deps.getSkillsRoot(), now);
          deps.reloadSkills?.();
          return { ok: true, ...placed };
        }
        if (!stat.isFile()) {
          return { ok: false, error: `Skill zip path is not a file: ${zipRef}` };
        }
        if (stat.size > MAX_SKILL_PACKAGE_BYTES) {
          return { ok: false, error: `Skill package exceeds the 4MB size limit (${stat.size} bytes).` };
        }
        downloaded = {
          buffer: fs.readFileSync(zipRef),
          contentType: 'application/zip',
        };
      } else {
        downloaded = await downloadSource(deps, zipRef);
      }
    } else if (githubRef) {
      const parsed = parseGithubSource(githubRef);
      if (!parsed) {
        return { ok: false, error: `Invalid github source: ${githubRef}` };
      }
      githubSubpath = parsed.subpath;
      downloaded = await downloadGithubArchive(deps, parsed);
    } else if (skillsShRef) {
      const resolved = await resolveSkillsShPackage(deps, skillsShRef);
      if (resolved.github) {
        const parsed = parseGithubSource(resolved.github);
        if (!parsed) {
          return { ok: false, error: `skills.sh resolved to an invalid github source: ${resolved.github}` };
        }
        githubSubpath = parsed.subpath;
        downloaded = await downloadGithubArchive(deps, parsed);
      } else if (resolved.url) {
        downloaded = await downloadSource(deps, resolved.url);
      }
    } else if (npmRef) {
      downloaded = await downloadNpmPackage(deps, npmRef);
    }

    if (!downloaded) {
      return { ok: false, error: 'Failed to download the skill package.' };
    }
    assertPackageSize(downloaded.buffer);

    const extractDir = path.join(staging, 'extracted');
    await extractArchiveToDir(downloaded.buffer, downloaded.contentType, extractDir);
    const placed = placeSkillFromExtracted(extractDir, deps.getSkillsRoot(), now, githubSubpath);
    deps.reloadSkills?.();
    return { ok: true, ...placed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    cleanupDir(staging);
  }
}

export function listInstalledSkills(deps: Pick<SkillInstallDeps, 'getSkillsRoot'>): InstalledSkillInfo[] {
  const root = deps.getSkillsRoot();
  if (!fs.existsSync(root)) return [];
  const skills: InstalledSkillInfo[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const skillFile = path.join(dir, SKILL_FILE_NAME);
    if (!fs.existsSync(skillFile)) continue;
    try {
      const parsed = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      skills.push({
        name: parsed.name || entry.name,
        version: parsed.version,
      });
    } catch {
      skills.push({ name: entry.name, version: '0' });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
