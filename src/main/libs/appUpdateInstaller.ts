import { app, session } from 'electron';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

let activeDownloadController: AbortController | null = null;

export function cancelActiveDownload(): boolean {
  if (activeDownloadController) {
    console.log('[AppUpdate] Download cancelled by user');
    activeDownloadController.abort('cancelled');
    activeDownloadController = null;
    return true;
  }
  return false;
}

/** Escape a string for safe use as a single-quoted POSIX shell argument. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function execAsync(command: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstderr: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Minimum interval between progress IPC events (ms). */
const PROGRESS_THROTTLE_MS = 200;

/** Abort download if no data received for this duration (ms). */
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

export async function downloadUpdate(
  url: string,
  onProgress: (progress: AppUpdateDownloadProgress) => void,
): Promise<string> {
  if (activeDownloadController) {
    throw new Error('A download is already in progress');
  }

  console.log(`[AppUpdate] Starting download: ${url}`);

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }

  const ext = path.extname(parsedUrl.pathname) || (process.platform === 'darwin' ? '.dmg' : '.exe');
  const tempDir = app.getPath('temp');
  const ts = Date.now();
  const downloadPath = path.join(tempDir, `idbots-update-${ts}${ext}.download`);
  const finalPath = path.join(tempDir, `idbots-update-${ts}${ext}`);

  console.log(`[AppUpdate] Temp path: ${downloadPath}`);
  console.log(`[AppUpdate] Final path: ${finalPath}`);

  const controller = new AbortController();
  activeDownloadController = controller;

  let writeStream: fs.WriteStream | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  const clearInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  };

  const resetInactivityTimer = () => {
    clearInactivityTimer();
    inactivityTimer = setTimeout(() => {
      console.error('[AppUpdate] Download inactivity timeout (60s), aborting');
      controller.abort('timeout');
    }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
  };

  try {
    const response = await session.defaultSession.fetch(url, {
      signal: controller.signal,
    });

    console.log(`[AppUpdate] HTTP response: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }

    if (!response.body) {
      throw new Error('Response has no body');
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : undefined;
    console.log(`[AppUpdate] Content-Length: ${totalHeader ?? 'unknown'}`);

    let received = 0;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = 0;
    let currentSpeed: number | undefined = undefined;
    let lastProgressTime = 0;

    const emitProgress = () => {
      onProgress({
        received,
        total: total && Number.isFinite(total) ? total : undefined,
        percent: total && Number.isFinite(total) ? received / total : undefined,
        speed: currentSpeed,
      });
    };

    // Emit initial progress
    emitProgress();

    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });
    writeStream = fs.createWriteStream(downloadPath);

    const nodeStream = Readable.fromWeb(response.body as any);

    // Start inactivity timer
    resetInactivityTimer();

    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;

      // Reset inactivity timer on each chunk
      resetInactivityTimer();

      // Calculate speed with 1-second window
      const now = Date.now();
      const elapsed = now - lastSpeedTime;
      if (elapsed >= 1000) {
        currentSpeed = ((received - lastSpeedBytes) / elapsed) * 1000;
        lastSpeedTime = now;
        lastSpeedBytes = received;
      }

      // Throttle progress events to avoid flooding IPC channel
      if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
        lastProgressTime = now;
        emitProgress();
      }
    });

    await pipeline(nodeStream, writeStream);
    writeStream = null;
    clearInactivityTimer();

    // Validate downloaded file
    const stat = await fs.promises.stat(downloadPath);
    console.log(`[AppUpdate] Download complete: ${stat.size} bytes`);

    if (stat.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    if (total && Number.isFinite(total) && stat.size !== total) {
      throw new Error(`Download incomplete: expected ${total} bytes but got ${stat.size}`);
    }

    // Rename to final path (atomic on same filesystem)
    await fs.promises.rename(downloadPath, finalPath);
    console.log(`[AppUpdate] File saved to: ${finalPath}`);

    // Emit final 100% progress
    onProgress({
      received,
      total: total && Number.isFinite(total) ? total : received,
      percent: 1,
      speed: currentSpeed,
    });

    return finalPath;
  } catch (error) {
    clearInactivityTimer();
    console.error('[AppUpdate] Download error:', error);

    // Clean up partial download
    try {
      if (writeStream) {
        writeStream.destroy();
      }
      await fs.promises.unlink(downloadPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }

    if (controller.signal.aborted) {
      if (controller.signal.reason === 'timeout') {
        throw new Error('Download timed out: no data received for 60 seconds');
      }
      throw new Error('Download cancelled');
    }
    throw error;
  } finally {
    activeDownloadController = null;
  }
}

export async function installUpdate(filePath: string): Promise<void> {
  console.log(`[AppUpdate] Installing update from: ${filePath}`);
  console.log(`[AppUpdate] Platform: ${process.platform}, Arch: ${process.arch}`);

  // Verify the file exists before attempting install
  try {
    const stat = await fs.promises.stat(filePath);
    console.log(`[AppUpdate] Installer file size: ${stat.size} bytes`);
    if (stat.size === 0) {
      throw new Error('Update file is empty');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Update file not found');
    }
    throw error;
  }

  if (process.platform === 'darwin') {
    return installMacDmg(filePath);
  }
  if (process.platform === 'win32') {
    return installWindowsNsis(filePath);
  }
  throw new Error('Unsupported platform');
}

async function installMacDmg(dmgPath: string): Promise<void> {
  let mountPoint: string | null = null;

  try {
    // Mount the DMG (timeout 60s)
    console.log('[AppUpdate] Mounting DMG...');
    const mountOutput = await execAsync(
      `hdiutil attach ${shellEscape(dmgPath)} -nobrowse -noautoopen -noverify`,
      60_000,
    );

    // Parse mount point from output (last line, last column)
    const lines = mountOutput.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    const mountMatch = lastLine?.match(/\t(\/Volumes\/.+)$/);
    if (!mountMatch) {
      throw new Error('Failed to determine mount point from hdiutil output');
    }
    mountPoint = mountMatch[1];
    console.log(`[AppUpdate] Mounted at: ${mountPoint}`);

    // Find .app bundle in mount point
    const entries = await fs.promises.readdir(mountPoint);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) {
      throw new Error('No .app bundle found in DMG');
    }

    const sourceApp = path.join(mountPoint, appBundle);
    console.log(`[AppUpdate] Source app: ${sourceApp}`);

    // Determine target path: current running app location
    // process.resourcesPath is .app/Contents/Resources, go up 3 levels
    const currentAppPath = path.resolve(process.resourcesPath, '..', '..', '..');
    let targetApp: string;

    if (currentAppPath.endsWith('.app')) {
      targetApp = currentAppPath;
    } else {
      // Fallback to /Applications
      targetApp = `/Applications/${appBundle}`;
    }
    console.log(`[AppUpdate] Target app: ${targetApp}`);

    // Try to copy the .app bundle (use shellEscape to prevent injection)
    try {
      console.log('[AppUpdate] Copying app bundle...');
      await execAsync(
        `rm -rf ${shellEscape(targetApp)} && cp -R ${shellEscape(sourceApp)} ${shellEscape(targetApp)}`,
        300_000,
      );
      console.log('[AppUpdate] Copy succeeded');
    } catch {
      // Permission denied: try with admin privileges via osascript
      console.log('[AppUpdate] Normal copy failed, requesting admin privileges...');
      try {
        // For osascript, escape backslashes and double quotes for the inner shell
        const escapeForInnerShell = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
        const escapedTarget = escapeForInnerShell(targetApp);
        const escapedSource = escapeForInnerShell(sourceApp);
        await execAsync(
          `osascript -e 'do shell script "rm -rf \\"${escapedTarget}\\" && cp -R \\"${escapedSource}\\" \\"${escapedTarget}\\"" with administrator privileges'`,
          300_000,
        );
        console.log('[AppUpdate] Admin copy succeeded');
      } catch (adminError) {
        throw new Error(
          `Installation failed: insufficient permissions. ${adminError instanceof Error ? adminError.message : ''}`,
        );
      }
    }

    // Detach DMG (timeout 30s)
    try {
      await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
    } catch {
      // Best effort
    }
    mountPoint = null;

    // Clean up downloaded DMG
    try {
      await fs.promises.unlink(dmgPath);
    } catch {
      // Best effort
    }

    // Relaunch from the new app location
    const executablePath = path.join(targetApp, 'Contents', 'MacOS');
    const execEntries = await fs.promises.readdir(executablePath);
    const executable = execEntries[0]; // Should be the app executable

    if (executable) {
      console.log(`[AppUpdate] Relaunching: ${path.join(executablePath, executable)}`);
      app.relaunch({ execPath: path.join(executablePath, executable) });
    } else {
      console.log('[AppUpdate] Relaunching (default)');
      app.relaunch();
    }
    app.quit();
  } catch (error) {
    console.error('[AppUpdate] macOS install error:', error);
    // Clean up mount point on error
    if (mountPoint) {
      try {
        await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
      } catch {
        // Best effort
      }
    }
    throw error;
  }
}

/**
 * Relaunch target recorded after a successful silent macOS apply.
 * Consumed by relaunchPendingMacUpdate() when the user confirms the restart.
 */
let pendingMacRelaunch: { execPath?: string } | null = null;

/** Relaunch into the silently-applied macOS update. Returns false when no update is pending. */
export async function relaunchPendingMacUpdate(): Promise<boolean> {
  if (!pendingMacRelaunch) {
    return false;
  }
  const { execPath } = pendingMacRelaunch;
  pendingMacRelaunch = null;
  if (execPath) {
    console.log(`[AppUpdate] Relaunching into updated app: ${execPath}`);
    app.relaunch({ execPath });
  } else {
    console.log('[AppUpdate] Relaunching (default)');
    app.relaunch();
  }
  app.quit();
  return true;
}

function isMacPermissionError(message: string): boolean {
  return /permission denied|operation not permitted|read-only file system/i.test(message);
}

/**
 * Silently replace the running .app bundle with the one inside the DMG.
 * No elevation prompt and no relaunch — on success the relaunch target is
 * stored for relaunchPendingMacUpdate(). On permission failure the thrown
 * error carries code 'EACCES' so the caller can fall back to the elevated
 * interactive install path. The DMG is deleted on success but kept on
 * failure so the fallback install can reuse it without re-downloading.
 */
export async function applyMacUpdateSilently(dmgPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Silent apply is only supported on macOS');
  }

  console.log(`[AppUpdate] Silent apply from: ${dmgPath}`);
  let mountPoint: string | null = null;

  try {
    const stat = await fs.promises.stat(dmgPath);
    if (stat.size === 0) {
      throw new Error('Update file is empty');
    }

    console.log('[AppUpdate] Mounting DMG...');
    const mountOutput = await execAsync(
      `hdiutil attach ${shellEscape(dmgPath)} -nobrowse -noautoopen -noverify`,
      60_000,
    );
    const lines = mountOutput.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    const mountMatch = lastLine?.match(/\t(\/Volumes\/.+)$/);
    if (!mountMatch) {
      throw new Error('Failed to determine mount point from hdiutil output');
    }
    mountPoint = mountMatch[1];

    const entries = await fs.promises.readdir(mountPoint);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) {
      throw new Error('No .app bundle found in DMG');
    }
    const sourceApp = path.join(mountPoint, appBundle);

    const currentAppPath = path.resolve(process.resourcesPath, '..', '..', '..');
    const targetApp = currentAppPath.endsWith('.app') ? currentAppPath : `/Applications/${appBundle}`;
    console.log(`[AppUpdate] Target app: ${targetApp}`);

    // Copy to a sibling directory first, then swap via mv: this keeps a valid
    // .app at the target path at all times (unlike rm -rf && cp -R).
    const ts = Date.now();
    const tmpApp = `${targetApp}.idbots-new-${ts}`;
    const oldApp = `${targetApp}.idbots-old-${ts}`;
    try {
      await execAsync(
        `cp -R ${shellEscape(sourceApp)} ${shellEscape(tmpApp)} && mv ${shellEscape(targetApp)} ${shellEscape(oldApp)} && mv ${shellEscape(tmpApp)} ${shellEscape(targetApp)} && rm -rf ${shellEscape(oldApp)}`,
        300_000,
      );
      console.log('[AppUpdate] Silent swap succeeded');
    } catch (copyError) {
      // Best-effort rollback: drop the partial copy, restore the original app
      // if the swap left the target path empty.
      await execAsync(
        `if [ -d ${shellEscape(tmpApp)} ]; then rm -rf ${shellEscape(tmpApp)}; fi; if [ ! -d ${shellEscape(targetApp)} ] && [ -d ${shellEscape(oldApp)} ]; then mv ${shellEscape(oldApp)} ${shellEscape(targetApp)}; fi`,
        60_000,
      ).catch(() => {});
      throw copyError;
    }

    try {
      await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
    } catch {
      // Best effort
    }
    mountPoint = null;

    try {
      await fs.promises.unlink(dmgPath);
    } catch {
      // Best effort
    }

    const executableDir = path.join(targetApp, 'Contents', 'MacOS');
    const execEntries = await fs.promises.readdir(executableDir);
    pendingMacRelaunch = { execPath: execEntries[0] ? path.join(executableDir, execEntries[0]) : undefined };
    console.log('[AppUpdate] Silent apply complete, update pending restart');
  } catch (error) {
    console.error('[AppUpdate] Silent apply error:', error);
    if (mountPoint) {
      try {
        await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
      } catch {
        // Best effort
      }
    }
    if (error instanceof Error && isMacPermissionError(error.message)) {
      (error as NodeJS.ErrnoException).code = 'EACCES';
    }
    throw error;
  }
}

async function installWindowsNsis(exePath: string): Promise<void> {
  console.log(`[AppUpdate] Windows NSIS install (interactive mode)`);
  console.log(`[AppUpdate]   installer: ${exePath}`);
  console.log(`[AppUpdate]   appPid: ${process.pid}`);

  // We must NOT spawn the installer directly as a child of the app, because
  // the NSIS customInit macro runs `taskkill /IM "IDBots.exe" /F /T`
  // which kills the entire process tree — including child processes.
  //
  // Strategy: use a tiny PowerShell script (launched via hidden VBS) that
  // waits for the app to fully exit, then opens the installer with its
  // normal UI (no /S silent flag). This lets NSIS handle everything:
  // desktop shortcuts, start menu entries, "Run after finish", etc.
  const ts = Date.now();
  const tempDir = app.getPath('temp');
  const logPath = path.join(tempDir, `idbots-update-${ts}.log`);
  const scriptPath = path.join(tempDir, `idbots-update-${ts}.ps1`);
  const vbsPath = path.join(tempDir, `idbots-update-${ts}.vbs`);

  console.log(`[AppUpdate] Script log: ${logPath}`);

  const psEscape = (s: string) => s.replace(/'/g, "''");

  const psScript = [
    `$logPath = '${psEscape(logPath)}'`,
    `$appPid = ${process.pid}`,
    `$installerPath = '${psEscape(exePath)}'`,
    '',
    'function Log($msg) {',
    "    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'",
    '    Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8',
    '}',
    '',
    'try {',
    '    Log "Update script started (appPid=$appPid)"',
    '',
    '    # Wait for the app to fully exit (by PID, max 120s)',
    '    $waited = 0',
    '    while ($waited -lt 120) {',
    '        try {',
    '            Get-Process -Id $appPid -ErrorAction Stop | Out-Null',
    '            Start-Sleep -Seconds 1',
    '            $waited++',
    '        } catch {',
    '            break',
    '        }',
    '    }',
    '    Log "App exited after $waited seconds"',
    '',
    '    # Launch installer with normal UI (NSIS handles shortcuts & relaunch)',
    '    Log "Launching installer: $installerPath"',
    '    Start-Process -FilePath $installerPath',
    '    Log "Done"',
    '} catch {',
    '    Log "ERROR: $($_.Exception.Message)"',
    '}',
  ].join('\r\n');

  await fs.promises.writeFile(scriptPath, '\ufeff' + psScript, 'utf-8');

  const vbsScript = `CreateObject("WScript.Shell").Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${scriptPath}""", 0, False`;
  await fs.promises.writeFile(vbsPath, vbsScript, 'utf-8');

  console.log('[AppUpdate] Launching installer via wscript.exe...');

  const launcher = spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
  });
  launcher.unref();

  console.log(`[AppUpdate] Launcher PID: ${launcher.pid}, calling app.quit()`);
  app.quit();
}
