import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// Group-task daemon log sink. The daemon's emitLog historically went to
// console.log only, which is invisible for packaged apps and lost on restart;
// persisting it lets stalled group tasks be diagnosed after the fact.
// Mirrors coworkLogger.ts (same directory, same rotation policy).

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let logFilePath: string | null = null;

function getLogFilePath(): string {
  if (!logFilePath) {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFilePath = path.join(logDir, 'grouptask.log');
  }
  return logFilePath;
}

function rotateIfNeeded(): void {
  try {
    const filePath = getLogFilePath();
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_LOG_SIZE) {
      const backupPath = filePath + '.old';
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
      fs.renameSync(filePath, backupPath);
    }
  } catch {
    // ignore rotation errors
  }
}

export function groupTaskLog(message: string): void {
  try {
    rotateIfNeeded();
    const timestamp = new Date().toISOString();
    // Prefix every line so multi-line messages stay attributable.
    const body = message
      .split('\n')
      .map((line) => `[${timestamp}] ${line}`)
      .join('\n');
    fs.appendFileSync(getLogFilePath(), `${body}\n`, 'utf-8');
  } catch {
    // Logging should never throw
  }
}

export function getGroupTaskLogPath(): string {
  return getLogFilePath();
}
