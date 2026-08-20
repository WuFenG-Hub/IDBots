import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const packageJsonPath = path.join(process.cwd(), 'package.json');
const mainProcessPath = path.join(process.cwd(), 'src', 'main', 'main.ts');
const skillManagerPath = path.join(process.cwd(), 'src', 'main', 'skillManager.ts');
const coworkRunnerPath = path.join(process.cwd(), 'src', 'main', 'libs', 'coworkRunner.ts');
const electronMainExternalsPath = path.join(process.cwd(), 'scripts', 'electron-main-externals.cjs');
const viteConfigPath = path.join(process.cwd(), 'vite.config.ts');
const require = createRequire(import.meta.url);

test('skillManager runtime YAML parser must be declared as production dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const skillManagerSource = fs.readFileSync(skillManagerPath, 'utf8');

  assert.match(
    skillManagerSource,
    /from 'js-yaml'/,
    'Expected skillManager to import js-yaml for frontmatter parsing',
  );

  assert.ok(
    packageJson.dependencies && packageJson.dependencies['js-yaml'],
    'js-yaml must be in dependencies so packaged app can load skillManager at runtime',
  );
});

test('web-search skill build must go through the runtime bootstrap wrapper', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const buildScript = packageJson.scripts?.['build:skill:web-search'] || '';
  const aggregateBuildScript = packageJson.scripts?.['build:skills'] || '';

  assert.match(
    buildScript,
    /node\s+scripts\/build-web-search-skill\.js/,
    'build:skill:web-search should use the web-search bootstrap script so fresh worktrees can install missing skill deps before tsc',
  );

  assert.match(
    aggregateBuildScript,
    /node\s+scripts\/build-web-search-skill\.js/,
    'build:skills should use the same web-search bootstrap script so electron:dev works in fresh worktrees',
  );
});

test('electron dev scripts use IPv4 loopback for Vite readiness', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const mainProcessSource = fs.readFileSync(mainProcessPath, 'utf8');
  const electronDevScript = packageJson.scripts?.['electron:dev'] || '';
  const startElectronScript = packageJson.scripts?.['start:electron'] || '';

  assert.match(
    electronDevScript,
    /http:\/\/127\.0\.0\.1:5175/,
    'electron:dev should wait for the Vite server on IPv4 loopback so localhost cannot resolve to an unrelated ::1 listener',
  );
  assert.doesNotMatch(
    electronDevScript,
    /http:\/\/localhost:5175/,
    'electron:dev should not wait on localhost because wait-on may probe IPv6 ::1 before this project server',
  );
  assert.match(
    startElectronScript,
    /ELECTRON_START_URL=http:\/\/127\.0\.0\.1:5175/,
    'Electron should load the same IPv4 loopback URL that electron:dev waits for',
  );
  assert.match(
    mainProcessSource,
    /ELECTRON_START_URL \|\| 'http:\/\/127\.0\.0\.1:5175'/,
    'The main process development fallback should avoid localhost for direct Electron starts too',
  );
});

test('Electron main build externalizes heavy runtime dependencies', () => {
  const { createElectronMainExternalPredicate } = require(electronMainExternalsPath);
  const external = createElectronMainExternalPredicate();
  const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

  assert.equal(external('@metalet/utxo-wallet-service'), true);
  assert.equal(external('@metalet/utxo-wallet-service/dist/index.js'), true);
  assert.equal(external('meta-contract'), true);
  assert.equal(external('@larksuiteoapi/node-sdk'), true);
  assert.equal(external('@scure/bip39/wordlists/english'), true);
  assert.equal(external('electron'), true);
  assert.equal(external('node:path'), true);
  assert.equal(external('./services/metabotWalletService'), false);
  assert.equal(external('/absolute/project/src/main/main.ts'), false);

  assert.match(
    viteConfigSource,
    /createElectronMainExternalPredicate/,
    'vite.config.ts should use the shared Electron main external predicate',
  );
  assert.match(
    viteConfigSource,
    /external:\s*electronMainExternal/,
    'Electron main Rollup config should externalize runtime dependencies instead of bundling node_modules into main.js',
  );
});

test('production Vite builds minify bundles without source maps', () => {
  const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

  assert.match(
    viteConfigSource,
    /const isProductionBuild = process\.env\.NODE_ENV === 'production'/,
    'vite.config.ts should keep a single production-build flag for build output options',
  );
  assert.equal(
    (viteConfigSource.match(/sourcemap:\s*!isProductionBuild/g) || []).length,
    3,
    'renderer, Electron main, and preload builds should omit source maps in production',
  );
  assert.equal(
    (viteConfigSource.match(/minify:\s*isProductionBuild\s*\?\s*'esbuild'\s*:\s*false/g) || []).length,
    3,
    'renderer, Electron main, and preload builds should minify only production bundles',
  );
});

test('Vite dev file watching avoids polling generated output by default', () => {
  const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

  assert.doesNotMatch(
    viteConfigSource,
    /usePolling:\s*true/,
    'Vite should not force polling by default because it keeps macOS dev servers busy even when idle',
  );
  assert.match(
    viteConfigSource,
    /const shouldUseVitePolling = process\.env\.IDBOTS_VITE_USE_POLLING === '1'/,
    'Polling should remain available as an explicit opt-in for filesystems that need it',
  );
  assert.match(
    viteConfigSource,
    /\*\*\/dist-electron\/\*\*/,
    'Vite should ignore Electron build output so generated files do not trigger dev rebuild work',
  );
  assert.match(
    viteConfigSource,
    /\*\*\/dist\/\*\*/,
    'Vite should ignore renderer build output while watching source files',
  );
});

test('SDK built-in web tools are gated by an explicit env flag', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /const ENABLE_SDK_WEB_TOOLS_ENV = 'IDBOTS_ENABLE_SDK_WEB_TOOLS'/,
    'CoworkRunner should expose SDK WebSearch/WebFetch through an explicit opt-in env flag',
  );
  assert.match(
    source,
    /export function shouldBlockBuiltinWebTool\(toolName: string\): boolean/,
    'CoworkRunner should keep the web tool gate in a testable helper',
  );
  assert.match(
    source,
    /if \(isSdkBuiltinWebToolsEnabled\(\)\) \{\s*return false;\s*\}/,
    'IDBOTS_ENABLE_SDK_WEB_TOOLS should disable the WebSearch/WebFetch block when truthy',
  );
  assert.match(
    source,
    /const BLOCKED_BUILTIN_WEB_TOOLS = new Set\(\['websearch', 'webfetch'\]\)/,
    'Default behavior should continue blocking SDK WebSearch and WebFetch',
  );
});

test('DeepSeek missing reasoning_content failures reset stale resume state once', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /function isDeepSeekMissingReasoningContentError\(message: string\): boolean/,
    'CoworkRunner should classify DeepSeek thinking history failures explicitly',
  );
  assert.match(
    source,
    /DeepSeek thinking history lost reasoning_content; retrying with fresh session/,
    'DeepSeek missing reasoning_content should trigger one fresh-session retry instead of leaving the run stuck',
  );
});

test('CoworkRunner uses MetaBot DeepSeek automation model for local service execution', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /resolveApiConfigForModel/,
    'CoworkRunner should be able to resolve a MetaBot-scoped automation model',
  );
  assert.match(
    source,
    /getSessionAutomationBrain/,
    'CoworkRunner should inspect the session MetaBot before local execution',
  );
  assert.match(
    source,
    /getEnhancedEnvWithTmpdir\(\s*cwd,\s*'local',\s*apiConfig\s*\)/,
    'CoworkRunner should pass the resolved API config into the child process environment',
  );
});

test('DSH shared runtime injects skill host env including IDBOTS_API_BASE_URL', () => {
  const coworkDshTurnSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkDshTurn.ts'),
    'utf8',
  );
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );
  const coworkRunnerSource = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    coworkUtilSource,
    /export function getSkillHostEnv/,
    'Skill host env must be a shared helper so Claude and DSH inject the same channels',
  );
  assert.match(
    coworkUtilSource,
    /env\.IDBOTS_API_BASE_URL = internalApiBaseURL/,
    'getSkillHostEnv must set IDBOTS_API_BASE_URL from the local cowork proxy',
  );
  assert.match(
    coworkDshTurnSource,
    /skillHostEnvProvider/,
    'DshTurnHub must accept a skill-host env provider for the shared child env',
  );
  assert.match(
    coworkDshTurnSource,
    /export function buildDshChildEnv/,
    'DSH child env merge must stay a testable helper',
  );
  assert.match(
    coworkRunnerSource,
    /skillHostEnvProvider:\s*\(\)\s*=>\s*\(\{[\s\S]*getSkillHostEnv\(\)[\s\S]*ensureDshSkillEnvChannel/,
    'CoworkRunner must wire getSkillHostEnv plus the BASH_ENV skill-session channel into the shared DSH runtime',
  );
});

test('DSH per-session skill env rides BASH_ENV after KEY/TOKEN scrub', () => {
  const coworkRunnerSource = fs.readFileSync(coworkRunnerPath, 'utf8');
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );
  const dshSkillEnvSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'dshSkillSessionEnv.ts'),
    'utf8',
  );

  assert.match(
    dshSkillEnvSource,
    /export const DSH_SKILL_ENV_LOADER_ENV = 'BASH_ENV'/,
    'Loader must use BASH_ENV so it survives DSH KEY/TOKEN scrub',
  );
  assert.match(
    dshSkillEnvSource,
    /DSH_SESSION_ID/,
    'Loader must select the env file by per-execution DSH_SESSION_ID',
  );
  assert.match(
    coworkUtilSource,
    /IDBOTS_RPC_URL:\s*getMetaidRpcBase\(\)/,
    'getSkillHostEnv must set IDBOTS_RPC_URL for skill scripts (global, not per-bot)',
  );
  assert.match(
    coworkRunnerSource,
    /private async syncDshSkillSessionEnv/,
    'CoworkRunner must write a per-DSH-session env file before the turn',
  );
  assert.match(
    coworkRunnerSource,
    /writeDshSkillSessionEnvFile/,
    'CoworkRunner must persist getSkillSessionEnvOverrides into the DSH session env file',
  );
  assert.match(
    coworkRunnerSource,
    /copyDshSkillSessionEnvFile/,
    'Subagent DSH sessions must inherit the parent skill env file',
  );
  assert.match(
    coworkRunnerSource,
    /private async runLocalKernel/,
    'Local sandbox fallbacks must dispatch through runLocalKernel so DSH stays the default',
  );
  assert.doesNotMatch(
    coworkUtilSource,
    /loadClaudeSdk/,
    'generateSessionTitle must not spawn the sunset Claude Agent SDK',
  );
  assert.match(
    coworkUtilSource,
    /chatCompletionWithTools/,
    'generateSessionTitle must use the configured provider one-shot, not a truncated first line',
  );
  assert.match(
    coworkRunnerSource,
    /Consumed queued manual compact via native DSH compactNow/,
    'runDshSessionLocal must consume leftover queued compact via native compactNow',
  );
  const mainProcessSource = fs.readFileSync(mainProcessPath, 'utf8');
  assert.match(
    mainProcessSource,
    /sessionUsesDshSubagents/,
    'Subagent panel IPC must route dsh: sessions away from loadClaudeSdk',
  );
  assert.doesNotMatch(
    mainProcessSource,
    /prewarmClaudeSdk/,
    'App startup must not pre-load the sunset Claude Agent SDK',
  );
});
test('Claude Agent SDK is pinned to the native-binary 0.3.x series without cli.js patching', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  assert.match(
    packageJson.dependencies['@anthropic-ai/claude-agent-sdk'],
    /^0\.3\./,
    'SDK 0.3.x ships the compiled native binary instead of cli.js',
  );
  assert.ok(
    packageJson.dependencies['@anthropic-ai/sdk'],
    'SDK 0.3.x declares @anthropic-ai/sdk as a required peer dependency',
  );
  assert.ok(
    packageJson.dependencies['@modelcontextprotocol/sdk'],
    'SDK 0.3.x declares @modelcontextprotocol/sdk as a required peer dependency',
  );
  assert.doesNotMatch(
    packageJson.scripts.postinstall,
    /patch-claude-sdk-cli/,
    'postinstall must not patch the removed cli.js bundle anymore',
  );
});

test('cowork subprocess env disables Claude Code nonessential external traffic', () => {
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );

  for (const flag of [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_AUTOUPDATER',
    'DISABLE_BUG_COMMAND',
  ]) {
    assert.match(
      coworkUtilSource,
      new RegExp(`env\\.${flag} = '1'`),
      `${flag} must be forced on so embedded Claude Code sessions never depend on Anthropic-operated endpoints`,
    );
  }
});

test('SDK query call sites isolate from user Claude Code settings sources', () => {
  const coworkRunnerSource = fs.readFileSync(coworkRunnerPath, 'utf8');
  const sandboxRunnerSource = fs.readFileSync(
    path.join(process.cwd(), 'sandbox', 'agent-runner', 'index.js'),
    'utf8',
  );

  assert.match(
    coworkRunnerSource,
    /settingSources:\s*\[\]/,
    'CoworkRunner must pass settingSources: [] so user settings env blocks cannot override the session provider env',
  );
  assert.match(
    sandboxRunnerSource,
    /settingSources:\s*\[\]/,
    'Sandbox runner must pass settingSources: [] for the same isolation',
  );
});

test('CoworkRunner injects SDK subagent overrides that inherit the main model', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /buildCoworkSdkAgentOverrides/,
    'CoworkRunner should build explicit SDK agent overrides instead of depending on SDK built-ins',
  );
  assert.match(
    source,
    /const agentModel = model\?\.trim\(\) \? model\.trim\(\) : undefined/,
    'CoworkRunner should derive an explicit subagent model from the active Cowork model',
  );
  assert.match(
    source,
    /Explore[\s\S]*?\.\.\.\(agentModel \? \{ model: agentModel \} : \{\}\)/,
    'Explore subagent override should inherit the active Cowork model',
  );
  assert.match(
    source,
    /'general-purpose'[\s\S]*?\.\.\.\(agentModel \? \{ model: agentModel \} : \{\}\)/,
    'general-purpose subagent override should inherit the active Cowork model',
  );
  assert.match(
    source,
    /options\.agents\s*=\s*\{[\s\S]*?buildCoworkSdkAgentOverrides\(apiConfig\.model\)/,
    'CoworkRunner should pass the overrides through SDK options.agents',
  );
});

test('sandbox runner mirrors IDBots cross-session host tools', () => {
  const sandboxRunnerPath = path.join(process.cwd(), 'sandbox/agent-runner/index.js');
  const source = fs.readFileSync(sandboxRunnerPath, 'utf8');

  assert.ok(
    source.includes('idbots_session_read_all'),
    'Sandbox runner should expose the full-session IDBots host tool',
  );
  assert.ok(
    source.includes('idbots_session_read_latest'),
    'Sandbox runner should expose the latest-message IDBots host tool',
  );
  assert.ok(
    source.includes('idbots_session_insert_user_message'),
    'Sandbox runner should expose the cross-session insert IDBots host tool',
  );
  assert.ok(
    source.includes("callHostTool('idbots_session_read_all'"),
    'Sandbox full-session tool should delegate to the matching host tool',
  );
  assert.ok(
    source.includes("callHostTool('idbots_session_read_latest'"),
    'Sandbox latest-message tool should delegate to the matching host tool',
  );
  assert.ok(
    source.includes("callHostTool('idbots_session_insert_user_message'"),
    'Sandbox insert tool should delegate to the matching host tool',
  );
  assert.ok(
    source.includes('twinOrchestrationEnabled === true') && source.includes("callHostTool('local_workers_list'"),
    'Sandbox Twin directory tool should be gated by trusted orchestration enablement and call the host',
  );
  assert.ok(
    source.includes("callHostTool('local_worker_delegate'"),
    'Sandbox Worker delegation tool should delegate to the host',
  );
  for (const toolName of ['twin_task_status', 'twin_task_cancel', 'twin_task_reassign']) {
    assert.ok(source.includes(`callHostTool('${toolName}'`), `Sandbox should delegate ${toolName} to the host`);
  }
});

test('CoworkRunner prompt teaches IDBots session links and write boundary', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.ok(
    source.includes('IDBots://{sessionId}'),
    'CoworkRunner prompt should teach the IDBots session link format',
  );
  assert.ok(
    source.includes('idbots_session_read_all'),
    'CoworkRunner prompt should mention the full-session read tool',
  );
  assert.ok(
    source.includes('idbots_session_read_latest'),
    'CoworkRunner prompt should mention the latest-message read tool',
  );
  assert.ok(
    source.includes('idbots_session_insert_user_message'),
    'CoworkRunner prompt should mention the cross-session insert tool',
  );
  assert.ok(
    source.includes('A2A sessions are read-only'),
    'CoworkRunner prompt should describe the A2A write boundary',
  );
});

test('Twin orchestration tools have a host-side gate and trusted sandbox registration flag', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');
  assert.match(source, /toolName === 'local_workers_list'[\s\S]*?isTwinSession\(sessionId\)/);
  assert.match(source, /toolName === 'local_worker_delegate'[\s\S]*?isTwinSession\(sessionId\)/);
  for (const toolName of ['twin_task_status', 'twin_task_cancel', 'twin_task_reassign']) {
    assert.match(source, new RegExp(`toolName === '${toolName}'[\\s\\S]*?isTwinSession\\(sessionId\\)`));
  }
  assert.match(source, /twinOrchestrationEnabled: Boolean\(this\.listLocalWorkers && this\.isTwinSession\(sessionId\)\)/);
});

test('release packaging wires nested DSH runtime install, extraResources, and pack gates', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/build.yml'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const builder = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'electron-builder.json'), 'utf8'));
  const hooks = fs.readFileSync(path.join(process.cwd(), 'scripts/electron-builder-hooks.cjs'), 'utf8');
  const runtimePkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'dsh-runtime/package.json'), 'utf8'));
  const dshResource = (builder.extraResources || []).find((entry) => entry && entry.from === 'dsh-runtime');

  assert.match(
    workflow,
    /working-directory:\s*dsh-runtime[\s\S]*?run:\s*npm ci/,
    'CI must npm ci in dsh-runtime so extraResources can copy node_modules',
  );
  assert.match(
    packageJson.scripts.postinstall,
    /npm install --prefix dsh-runtime/,
    'postinstall must install dsh-runtime so local dist:mac also ships node_modules',
  );
  assert.ok(dshResource, 'electron-builder extraResources must copy dsh-runtime');
  assert.ok(
    !(dshResource.filter || []).some((pattern) => typeof pattern === 'string' && pattern.startsWith('!') && pattern.includes('node_modules')),
    'dsh-runtime extraResources filter must not exclude node_modules',
  );
  assert.match(hooks, /verifySourceRuntimes\(\)/, 'beforePack must fail closed if nested runtime deps are missing');
  assert.match(hooks, /verifyPackagedRuntimes\(context\)/, 'afterPack must fail closed if the copied app Resources omit runtime deps');
  assert.match(
    workflow,
    /node scripts\/setup-ffmpeg\.js --required/,
    'CI must download gitignored ffmpeg binaries; electron-builder only warns when the extraResource is missing',
  );
  assert.match(hooks, /ensureFfmpeg\(/, 'beforePack must download ffmpeg for the current target if the binary is absent');
  assert.match(hooks, /verifySourceFfmpeg\(context\)/, 'beforePack must fail closed if ffmpeg was not prepared');
  assert.match(hooks, /verifyPackagedFfmpeg\(context\)/, 'afterPack must fail closed if the copied app Resources omit ffmpeg');
  assert.ok(
    (builder.mac?.extraResources || []).some((entry) => entry && entry.from === 'resources/ffmpeg/ffmpeg-darwin-${arch}'),
    'mac extraResources must copy the arch-specific ffmpeg binary',
  );
  assert.ok(
    (builder.win?.extraResources || []).some((entry) => entry && entry.from === 'resources/ffmpeg/ffmpeg-win32-x64.exe'),
    'win extraResources must copy the Windows ffmpeg binary',
  );
  assert.equal(
    runtimePkg.dependencies['@deepseek-ai/dsh-sdk-client'],
    '0.1.0-rc.8',
    'dsh-sdk-client is a packaged runtime dependency of the Electron host, not a test-only devDependency',
  );
  assert.equal(
    runtimePkg.devDependencies?.['@deepseek-ai/dsh-sdk-client'],
    undefined,
    'dsh-sdk-client must not live in dsh-runtime devDependencies (NODE_ENV=production would omit it)',
  );
  assert.ok(
    fs.existsSync(path.join(process.cwd(), 'dsh-runtime', 'bin.mjs')),
    'dsh-runtime/bin.mjs must exist for the packaged DSH kernel entry',
  );
});

test('packaged runtime gates fail closed on missing source and packaged markers', () => {
  const {
    missingMarkers,
    verifySourceRuntimes,
    verifyPackagedRuntimes,
    verifySourceFfmpeg,
    verifyPackagedFfmpeg,
    resolvePackagedResourcesDir,
    resolveFfmpegPlatformKey,
    extraResourceFilterExcludesNodeModules,
  } = require('../scripts/packagedRuntimes.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-packaged-runtimes-'));

  try {
    assert.deepEqual(
      missingMarkers(tmpRoot, ['bin.mjs', path.join('node_modules', 'missing.js')]),
      ['bin.mjs', path.join('node_modules', 'missing.js')],
    );
    fs.writeFileSync(path.join(tmpRoot, 'bin.mjs'), 'ok');
    assert.deepEqual(missingMarkers(tmpRoot, ['bin.mjs']), []);

    assert.throws(
      () => verifySourceRuntimes(tmpRoot),
      /dsh-runtime\/bin\.mjs/,
    );

    const macResources = resolvePackagedResourcesDir({
      appOutDir: path.join(tmpRoot, 'mac-out'),
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'IDBots' } },
    });
    assert.equal(
      macResources,
      path.join(tmpRoot, 'mac-out', 'IDBots.app', 'Contents', 'Resources'),
    );
    assert.throws(
      () => verifyPackagedRuntimes({
        appOutDir: path.join(tmpRoot, 'mac-out'),
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'IDBots' } },
      }),
      /dsh-runtime\/bin\.mjs/,
    );

    assert.equal(
      resolveFfmpegPlatformKey({ electronPlatformName: 'darwin', arch: 3 }),
      'darwin-arm64',
    );
    assert.equal(
      resolveFfmpegPlatformKey({ electronPlatformName: 'win32', arch: 1 }),
      'win32-x64',
    );
    assert.equal(
      resolveFfmpegPlatformKey({ electronPlatformName: 'linux', arch: 1 }),
      null,
    );
    const macFfmpegContext = {
      appOutDir: path.join(tmpRoot, 'mac-out'),
      electronPlatformName: 'darwin',
      arch: 'arm64',
      packager: { appInfo: { productFilename: 'IDBots' } },
    };
    assert.throws(
      () => verifySourceFfmpeg(macFfmpegContext, tmpRoot),
      /bundled ffmpeg for darwin-arm64/,
    );
    assert.throws(
      () => verifyPackagedFfmpeg(macFfmpegContext),
      /missing bundled ffmpeg/,
    );

    assert.equal(extraResourceFilterExcludesNodeModules(['**/*', '!**/node_modules/**']), true);
    assert.equal(extraResourceFilterExcludesNodeModules(['**/*', '!**/.test-sessions/**']), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ffmpeg Windows download maps the extension-less release asset to the local .exe target', () => {
  const setupFfmpeg = require(path.join(process.cwd(), 'scripts', 'setup-ffmpeg.js'));
  assert.equal(setupFfmpeg.PLATFORM_ASSETS['win32-x64'], 'ffmpeg-win32-x64.exe');
  assert.equal(setupFfmpeg.REMOTE_ASSETS['win32-x64'], 'ffmpeg-win32-x64');
});
