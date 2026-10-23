/**
 * Repro harness for the `check_metafile_route` host tool.
 *
 * Runs the BUILT tool (`dist-electron/main/libs/metafileRouteAgentTools.js`)
 * against real pinIds and prints exactly the text an MCP caller receives, so a
 * before/after diff is one rerunnable command.
 *
 *   pnpm run compile:electron
 *   node scripts/probe-metafile-route-repro.mjs <pinId|metafile://pinId> [...]
 *
 * Known-good pins (healthy accelerate 307 -> OSS 206 + real mp4 bytes):
 *   22fd229017eaffc62324881148bfe24df3e9d4cd290c4da349adc07a744a057bi0
 *   ebaa1c886295f78a9f2ee3018504073e1252df611eab2e1275153402a76ae639i0
 * Known-broken pin (never published; both routes answer 200 + 72B JSON 40400):
 *   ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffi0
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMetafileRouteAgentTools } = require(
  '../dist-electron/main/libs/metafileRouteAgentTools.js'
);

const pins = process.argv.slice(2);
if (pins.length === 0) {
  console.error('usage: node scripts/probe-metafile-route-repro.mjs <pinId|metafile://pinId> [...]');
  process.exit(2);
}

const [tool] = buildMetafileRouteAgentTools({
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
});

for (const pin of pins) {
  const uri = pin.startsWith('metafile://') ? pin : `metafile://${pin}`;
  const result = await tool.handler({ uri });
  console.log('='.repeat(72));
  console.log(result.content[0].text);
}
