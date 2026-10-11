/**
 * Default names for the Twin Bot the welcome flow creates.
 *
 * These are placeholders the user is expected to replace in the first chat, so
 * they stay short, English-only (a bot name is on-chain identity, independent
 * of the UI language) and easy to say out loud. Extend or reorder the pool
 * freely — `pickTwinBotName` only requires it to be non-empty.
 */

export const TWIN_BOT_NAME_POOL = [
  'Pixel', 'Bit', 'Byte', 'Sprite', 'Dot', 'Chip', 'Glitch', 'Widget', 'Gizmo', 'Tinker',
  'Bolt', 'Ziggy', 'Otto', 'Rusty', 'Cog', 'Turbo', 'Nova', 'Comet', 'Orbit', 'Astro',
  'Lyra', 'Vega', 'Cosmo', 'Nebula', 'Stellar', 'Quasar', 'Eclipse', 'Halo', 'Mochi', 'Biscuit',
  'Pudding', 'Noodle', 'Beans', 'Waffles', 'Muffin', 'Pickles', 'Peanut', 'Cookie', 'Tofu', 'Boba',
  'Pebble', 'Clover', 'Maple', 'Sunny', 'Breeze', 'Ember', 'Frost', 'River', 'Aspen', 'Willow',
  'Echo', 'Muse', 'Scribe', 'Atlas', 'Scout', 'Sage', 'Pepper', 'Jinx', 'Rune', 'Fable',
];

/** One pool entry, picked without repetition protection (the pool is large). */
export function pickTwinBotName(random = Math.random) {
  const index = Math.floor(random() * TWIN_BOT_NAME_POOL.length);
  return TWIN_BOT_NAME_POOL[Math.min(Math.max(index, 0), TWIN_BOT_NAME_POOL.length - 1)];
}
