// Semver-aware version comparison for the app updater.
//
// Handles the release-channel formats used by update.json ("1.0.0",
// "1.0.0-rc.4", "1.0.0+build.5") with semver §11 precedence rules:
// a release outranks any prerelease of the same core, prerelease
// identifiers compare numerically when both sides are numeric, numeric
// identifiers rank below alphanumeric ones, and a shorter identifier
// list ranks lower when it is a prefix of the other. Build metadata
// (everything after "+") is ignored. The core keeps the legacy lenient
// parse (leading integer of each dot-separated part, missing parts
// count as 0, extra numeric segments keep participating in the numeric
// core) so plain numeric versions keep their old behavior, and
// malformed input degrades to that same lenient parse instead of
// throwing.
//
// Kept dependency-free on purpose: the update tests load this module
// directly with Node's native TypeScript type stripping.

type PrereleaseIdentifier = string | number;

type ParsedVersion = {
  core: number[];
  prerelease: PrereleaseIdentifier[] | null;
};

const NUMERIC_IDENTIFIER_RE = /^\d+$/;

const parseVersion = (version: string): ParsedVersion => {
  const text = String(version ?? '');
  const withoutBuild = text.split('+')[0];
  const [coreText, prereleaseText] = withoutBuild.split('-');

  const core = coreText.split('.').map((part) => {
    const match = part.trim().match(/^\d+/);
    return match ? Number.parseInt(match[0], 10) : 0;
  });

  if (prereleaseText === undefined || prereleaseText.trim() === '') {
    return { core, prerelease: null };
  }

  const prerelease = prereleaseText
    .split('.')
    .map((identifier) => {
      const trimmed = identifier.trim();
      return NUMERIC_IDENTIFIER_RE.test(trimmed)
        ? Number.parseInt(trimmed, 10)
        : trimmed;
    })
    .filter((identifier) => identifier !== '');

  return { core, prerelease: prerelease.length > 0 ? prerelease : null };
};

/**
 * Core numeric parts of a version: the leading integer of each
 * dot-separated segment (missing parts count as 0). Prerelease and
 * build metadata are not part of the core.
 */
export const toVersionParts = (version: string): number[] => (
  parseVersion(version).core
);

/**
 * Semver §11 precedence: positive when `a` is newer than `b`, negative
 * when older, 0 when equal (build metadata ignored).
 */
export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);

  const maxCoreLength = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < maxCoreLength; i += 1) {
    const leftPart = left.core[i] ?? 0;
    const rightPart = right.core[i] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const maxPreLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < maxPreLength; i += 1) {
    const leftId = left.prerelease[i];
    const rightId = right.prerelease[i];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const leftIsNumber = typeof leftId === 'number';
    const rightIsNumber = typeof rightId === 'number';
    if (leftIsNumber && rightIsNumber) {
      if (leftId > rightId) return 1;
      if (leftId < rightId) return -1;
    } else if (leftIsNumber) {
      // Numeric identifiers always rank below alphanumeric ones.
      return -1;
    } else if (rightIsNumber) {
      return 1;
    } else if (leftId !== rightId) {
      return leftId > rightId ? 1 : -1;
    }
  }

  return 0;
};
