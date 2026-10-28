import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapacitorConfig, getFlavor } from './flavors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flavor = getFlavor(process.argv[2] || 'staging');
const config = createCapacitorConfig(flavor.name);

writeFileSync(resolve(root, 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);

const template = resolve(root, 'native/idbots-native-bootstrap.js');
const outputs = [
  resolve(root, 'android/app/src/main/assets/idbots-native-bootstrap.js'),
  resolve(root, 'ios/App/App/idbots-native-bootstrap.js'),
];
for (const output of outputs) {
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(template, output);
}

const flavorPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Flavor</key>
  <string>${flavor.name}</string>
  <key>RemoteOrigin</key>
  <string>${flavor.remoteOrigin}</string>
</dict>
</plist>
`;
writeFileSync(resolve(root, 'ios/App/App/NativeShellFlavor.plist'), flavorPlist);
console.log(`Selected ${flavor.name}: ${flavor.remoteOrigin}`);
