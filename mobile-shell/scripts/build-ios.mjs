import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFlavor } from './flavors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flavor = getFlavor(process.argv[2] || 'staging');
const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [resolve(root, 'scripts/select-flavor.mjs'), flavor.name], root);
run(process.execPath, [resolve(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'ios'], root);
run('xcodebuild', [
  '-workspace', resolve(root, 'ios/App/App.xcworkspace'),
  '-scheme', 'App',
  '-configuration', 'Debug',
  '-sdk', 'iphonesimulator',
  '-destination', process.env.IDBOTS_IOS_DESTINATION || 'generic/platform=iOS Simulator',
  '-derivedDataPath', resolve(root, 'ios/DerivedData'),
  'CODE_SIGNING_ALLOWED=NO',
  'build',
], root);
