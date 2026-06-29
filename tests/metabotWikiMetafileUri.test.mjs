import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const runtimeScript = path.join(repoRoot, 'SKILLs/metabot-create-wiki/assets/metabot-llm-wiki-runtime/scripts/index.js');

async function runRuntime(payload, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [runtimeScript, '--payload', JSON.stringify(payload)], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

test('publish_zip uses an extension-bearing metafile URI for uploaded wiki bundles', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-wiki-metafile-'));
  const skillsRoot = path.join(tempRoot, 'skills');
  const uploadScript = path.join(skillsRoot, 'metabot-upload-largefile/scripts/upload-largefile.js');
  await mkdir(path.dirname(uploadScript), { recursive: true });
  await writeFile(
    uploadScript,
    [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({',
      '  success: true,',
      '  pinId: "wiki-zip-pin-i0",',
      '  fileName: "bundle.zip",',
      '  size: 123,',
      '  contentType: "application/zip",',
      '  uploadMode: "direct"',
      '}) + "\\n");',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(uploadScript, 0o755);

  const rootDir = path.join(tempRoot, 'kb');
  const zipPath = path.join(rootDir, 'manifests/wiki.zip');
  await mkdir(path.dirname(zipPath), { recursive: true });
  await writeFile(zipPath, 'zip bytes\n', 'utf8');

  const result = await runRuntime(
    {
      action: 'publish_zip',
      kbId: 'test-wiki',
      payload: {
        rootDir,
        zipPath,
        uploadZip: true,
      },
    },
    { SKILLS_ROOT: skillsRoot },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.json?.success, true);
  assert.equal(result.json?.data?.zipUri, 'metafile://wiki-zip-pin-i0.zip');
});
