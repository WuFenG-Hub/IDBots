import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    /getSessionAutomationModelOverride/,
    'CoworkRunner should inspect the session MetaBot before local execution',
  );
  assert.match(
    source,
    /getEnhancedEnvWithTmpdir\(\s*cwd,\s*'local',\s*apiConfig\s*\)/,
    'CoworkRunner should pass the resolved API config into the child process environment',
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
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );
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
    coworkUtilSource,
    /settingSources:\s*\[\]/,
    'Session title generation must pass settingSources: [] for the same isolation',
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
