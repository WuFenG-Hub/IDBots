import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { MetabotStore } from '../metabotStore';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';
import { createPin } from './metaidCore';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { getMvcSpendCoordinator } from './mvcSpendCoordinator';
import { resolveMetaFileUploadSharedModulePath } from './metaFileUploadSharedResolver';
import { getMainWorkerCandidatePaths, resolveMainWorkerPath } from './workerPathResolver';

function loadMetaFileUploadShared(): {
  DEFAULT_CHUNK_THRESHOLD_BYTES: number;
  DEFAULT_MAX_FILE_SIZE_BYTES: number;
  inferContentTypeFromFilePath: (filePath: string) => string;
  normalizeRpcUploadResult: (payload: Record<string, unknown>) => Record<string, unknown>;
  normalizeUploadContentType: (contentType: string) => string;
  normalizeUploadNetwork: (network?: string) => 'mvc' | 'btc' | 'opcat';
  validateUploadSize: (input: { sizeBytes: number; maxSizeBytes?: number }) => number;
  selectUploadMode: (input: { sizeBytes: number; chunkThresholdBytes?: number }) => 'direct' | 'chunked';
} {
  const modulePath = resolveMetaFileUploadSharedModulePath({
    moduleDir: __dirname,
    appPath: app.getAppPath(),
    exists: fs.existsSync,
  });
  if (!modulePath) {
    throw new Error('metaFileUploadShared module not found');
  }
  return require(modulePath) as ReturnType<typeof loadMetaFileUploadShared>;
}

const {
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  inferContentTypeFromFilePath,
  normalizeRpcUploadResult,
  normalizeUploadContentType,
  normalizeUploadNetwork,
  validateUploadSize,
  selectUploadMode,
} = loadMetaFileUploadShared();

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

export interface UploadMetaFileParams {
  metabotId: number;
  /** Path to file on disk. Mutually exclusive with `data`. */
  filePath?: string;
  /** In-memory file bytes. Mutually exclusive with `filePath`. */
  data?: Buffer;
  /** File name used for contentType inference when `data` is provided. */
  dataFileName?: string;
  contentType?: string;
  network?: string;
  chunkThresholdBytes?: number;
  maxSizeBytes?: number;
  uploaderBaseUrl?: string;
}

interface ChunkWorkerPayload {
  filePath: string;
  fileName: string;
  size: number;
  contentType: string;
  metaId: string;
  address: string;
  feeRate: number;
  maxSizeBytes: number;
  uploaderBaseUrl?: string;
}

function getErrorMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

async function runUploadLargeFileWorker(
  payload: ChunkWorkerPayload,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const workerBasename = 'uploadLargeFileWorker.js';
  const appPath = app.getAppPath();
  const candidatePaths = getMainWorkerCandidatePaths({
    moduleDir: __dirname,
    appPath,
    workerBasename,
  });
  const workerPath = resolveMainWorkerPath({
    moduleDir: __dirname,
    appPath,
    workerBasename,
    exists: fs.existsSync,
  });
  if (!workerPath) {
    throw new Error(`Worker not found: ${workerBasename}. Tried: ${candidatePaths.join(', ')}`);
  }

  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    throw new Error('Electron executable not found');
  }

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(electronExe, [workerPath], {
      cwd: app.getPath('userData'),
      env: {
        ...baseEnv,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (err) => {
      reject(new Error(getErrorMessage(err)));
    });

    child.once('close', () => {
      const output = stdout.trim() || stderr.trim();
      if (!output) {
        reject(new Error('Worker returned empty output'));
        return;
      }

      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last) as { success?: boolean; error?: string };
        if (!parsed.success) {
          reject(new Error(parsed.error || 'Large file upload worker failed'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error(output));
      }
    });

    child.stdin?.write(JSON.stringify(payload), () => {
      child.stdin?.end();
    });
  });
}

export async function uploadMetaFile(
  metabotStore: MetabotStore,
  params: UploadMetaFileParams,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(params.metabotId) || params.metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }

  const useData = Buffer.isBuffer(params.data) && params.data.length > 0;
  const useFile = !useData && Boolean(String(params.filePath || '').trim());
  if (!useData && !useFile) {
    throw new Error('Either filePath or data is required');
  }

  let resolvedFilePath = '';
  let fileName = '';
  let size: number;
  let dataBuffer: Buffer | null = null;

  if (useData) {
    dataBuffer = params.data as Buffer;
    size = validateUploadSize({
      sizeBytes: dataBuffer.length,
      maxSizeBytes: params.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    });
    fileName = String(params.dataFileName || 'homepage-upload').trim() || 'homepage-upload';
  } else {
    resolvedFilePath = path.resolve(String(params.filePath || '').trim());
    if (!resolvedFilePath) {
      throw new Error('file_path is required');
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolvedFilePath);
    } catch {
      throw new Error(`File not found: ${resolvedFilePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${resolvedFilePath}`);
    }
    size = validateUploadSize({
      sizeBytes: stat.size,
      maxSizeBytes: params.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    });
    fileName = path.basename(resolvedFilePath);
  }

  const network = normalizeUploadNetwork(params.network);
  const contentType = normalizeUploadContentType(
    params.contentType || inferContentTypeFromFilePath(fileName),
  );
  const uploadMode = selectUploadMode({
    sizeBytes: size,
    chunkThresholdBytes: params.chunkThresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES,
  });

  if (uploadMode === 'direct') {
    const buffer = dataBuffer ?? await fs.promises.readFile(resolvedFilePath);
    const feeRate = getGlobalFeeRate(network);
    const result = await createPin(
      metabotStore,
      params.metabotId,
      {
        operation: 'create',
        path: '/file',
        encryption: '0',
        version: '1.0',
        contentType,
        payload: buffer,
      },
      {
        network,
        feeRate,
      },
    );

    return normalizeRpcUploadResult({
      pinId: result.pinId,
      fileName,
      size,
      contentType,
      uploadMode: 'direct',
    });
  }

  if (network !== 'mvc') {
    throw new Error('Large file upload currently supports MVC only.');
  }

  const metabot = metabotStore.getMetabotById(params.metabotId);
  if (!metabot) {
    throw new Error(`MetaBot not found: ${params.metabotId}`);
  }
  if (!metabot.metaid?.trim()) {
    throw new Error(`MetaBot ${params.metabotId} has no metaid`);
  }
  if (!metabot.mvc_address?.trim()) {
    throw new Error(`MetaBot ${params.metabotId} has no mvc address`);
  }

  const wallet = metabotStore.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error(`MetaBot ${params.metabotId} wallet not found`);
  }

  const workerResult = await getMvcSpendCoordinator().runMvcSpendJob({
    metabotId: params.metabotId,
    action: `chunked_upload:${fileName}`,
    execute: async () => runUploadLargeFileWorker(
      {
        filePath: resolvedFilePath,
        fileName,
        size,
        contentType,
        metaId: metabot.metaid.trim(),
        address: metabot.mvc_address.trim(),
        feeRate: getGlobalFeeRate('mvc'),
        maxSizeBytes: params.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
        uploaderBaseUrl: params.uploaderBaseUrl,
      },
      {
        IDBOTS_METABOT_MNEMONIC: wallet.mnemonic.trim(),
        IDBOTS_METABOT_PATH: (wallet.path || DEFAULT_PATH).trim(),
      },
    ),
  });

  return normalizeRpcUploadResult(workerResult);
}
