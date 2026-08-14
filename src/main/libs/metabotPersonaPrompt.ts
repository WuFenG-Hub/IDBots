/**
 * The ONE MetaBot persona builder (persona slot content for the shared
 * prompt-composition grid).
 *
 * Every channel (cowork sessions, group tasks, A2A private chat, group chat)
 * renders a bot's persona through this module so the same bot carries one
 * identity everywhere. Channels layer their framing AROUND this block as
 * separate sections; they must never restate name/role/soul/goal/bio facts
 * or a second identity line — restating is how persona layers start fighting.
 */

/** Persona facts from a metabots row; nullable fields are skipped when empty. */
export interface MetabotPersonaPromptSource {
  id?: number | null;
  name?: string | null;
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
  mvc_address?: string | null;
  globalmetaid?: string | null;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the persona block as structured XML. Returns '' when the row carries
 * no usable persona facts (callers drop the section silently). The
 * metabot_id tag is always injected when an id exists so identity-bound
 * tools keep working even for a sparse persona.
 */
export function buildMetabotPersonaPrompt(metabot: MetabotPersonaPromptSource): string {
  const tags: string[] = [];
  if (metabot.name?.trim()) {
    tags.push(`  <name>${escapeXmlText(metabot.name.trim())}</name>`);
  }
  if (metabot.id != null) {
    tags.push(`  <metabot_id>${escapeXmlText(String(metabot.id))}</metabot_id>`);
  }
  if (metabot.mvc_address?.trim()) {
    tags.push(`  <mvc_address>${escapeXmlText(metabot.mvc_address.trim())}</mvc_address>`);
  }
  if (metabot.globalmetaid?.trim()) {
    tags.push(`  <globalmetaid>${escapeXmlText(metabot.globalmetaid.trim())}</globalmetaid>`);
  }
  if (metabot.role?.trim()) {
    tags.push(`  <role>${escapeXmlText(metabot.role.trim())}</role>`);
  }
  const bio = metabot.bio ?? metabot.background;
  if (bio?.trim()) {
    tags.push(`  <bio>${escapeXmlText(bio.trim())}</bio>`);
  }
  if (metabot.soul?.trim()) {
    tags.push(`  <soul>${escapeXmlText(metabot.soul.trim())}</soul>`);
  }
  if (metabot.goal?.trim()) {
    tags.push(`  <goal>${escapeXmlText(metabot.goal.trim())}</goal>`);
  }
  if (tags.length === 0) return '';

  const identityBlock = ['<metabot_identity>', ...tags, '</metabot_identity>'].join('\n');
  const instructionBlock =
    '<instruction>\nYou must strictly adhere to the persona, soul, and bio defined in the &lt;metabot_identity&gt; block above for all responses in this session.\n</instruction>';
  return `${identityBlock}\n${instructionBlock}`;
}
