import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFlavor } from './flavors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flavor = getFlavor(process.argv[2] || 'staging');
const localJavaHome = resolve(root, '.tooling/jdk-home/Home');
const javaHome = process.env.JAVA_HOME || (existsSync(resolve(localJavaHome, 'bin/java')) ? localJavaHome : undefined);
if (!javaHome) throw new Error('Set JAVA_HOME to a JDK 21 installation before building Android');

const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(process.env.HOME || '', 'Library/Android/sdk');
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  GRADLE_USER_HOME: resolve(root, '.tooling/gradle'),
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [resolve(root, 'scripts/select-flavor.mjs'), flavor.name], root);
run(process.execPath, [resolve(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], root);
const task = flavor.name === 'production' ? 'assembleProductionDebug' : 'assembleStagingDebug';
run(resolve(root, 'android/gradlew'), [task], resolve(root, 'android'));
