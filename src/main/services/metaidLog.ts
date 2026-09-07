/**
 * Shared metaid-rpc.log appender. Lives in its own module so sponsor
 * orchestration files (mvcSponsorCreatePin / mvcSponsorUpload) can log
 * without importing metaidCore (which imports them back).
 */

import fs from 'fs';
import path from 'path';

const METAID_RPC_LOG = 'metaid-rpc.log';

export function appendMetaidLog(level: string, message: string, details?: object): void {
  try {
    const { app } = require('electron');
    const logDir = app.getPath('userData');
    const logPath = path.join(logDir, METAID_RPC_LOG);
    const line = `[${new Date().toISOString()}] [${level}] ${message}${details ? '\n' + JSON.stringify(details, null, 2) : ''}\n`;
    fs.appendFileSync(logPath, line);
  } catch {
    // Ignore if app not ready
  }
}
