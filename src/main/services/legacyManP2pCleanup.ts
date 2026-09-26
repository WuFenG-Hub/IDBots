/**
 * One-time detection of user data left behind by the removed man-p2p runtime
 * (the userData/man-p2p Pebble database). Pure fs logic so the offer decision
 * is unit-testable without an Electron runtime; the dialog + trash flow lives
 * in main.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface LegacyManP2pData {
  dir: string;
  sizeBytes: number;
}

// macOS AppleDouble sidecars on exFAT/FAT volumes — not real data.
const SIDECAR_PREFIX = '._';

export function findLegacyManP2pData(userDataPath: string): LegacyManP2pData | null {
  const dir = path.join(userDataPath, 'man-p2p');
  let sizeBytes = 0;
  let realEntries = 0;

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(SIDECAR_PREFIX)) continue;
      realEntries += 1;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        sizeBytes += fs.statSync(child).size;
      }
    }
  };

  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return null;
    walk(dir);
  } catch {
    return null;
  }

  if (realEntries === 0) return null;
  return { dir, sizeBytes };
}

export function formatDataSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
