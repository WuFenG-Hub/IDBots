/**
 * Minimal semver comparison for image labels (`org.idbots.version`,
 * `org.idbots.rollback-safe-to`). Only `major.minor.patch` is compared;
 * pre-release and build metadata are ignored (fake images use simple
 * versions). Invalid input parses to null and comparisons treat two
 * unparseable versions as equal — label hygiene is the image owner's job.
 */

export type SemverTriple = [number, number, number];

export function parseSemver(version: string | null | undefined): SemverTriple | null {
  if (!version) {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 when a < b, 0 when equal (or both unparseable), 1 when a > b. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return 0;
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

export function semverLt(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareSemver(a, b) < 0;
}

export function semverGte(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareSemver(a, b) >= 0;
}
