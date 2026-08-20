/**
 * Detect whether a base system prompt already EMBEDS skill routing content
 * (legacy renderer prompts with an inline catalog, or user-pinned skill
 * blocks). Prose MENTIONS of the markers must not count: the default cowork
 * system prompt (sandbox/agent-runner/AGENT_SYSTEM_PROMPT.md) references the
 * skills catalog in its web-search rule, and a bare-tag test would
 * misclassify every default session as 'legacy' — suppressing both the
 * rules section and the volatile catalog, leaving the model with no skills
 * at all. Only a paired block or the mandatory heading means the prompt
 * actually carries skill content.
 */
const INLINE_SKILLS_HEADING = /## Skills \(mandatory\)/;
const AVAILABLE_SKILLS_BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/;
const SKILL_CONTEXT_BLOCK = /<skill_context>[\s\S]*?<\/skill_context>/;

export function hasEmbeddedSkillCatalog(baseSystemPrompt: string | null | undefined): boolean {
  const prompt = baseSystemPrompt ?? '';
  return INLINE_SKILLS_HEADING.test(prompt)
    || AVAILABLE_SKILLS_BLOCK.test(prompt)
    || SKILL_CONTEXT_BLOCK.test(prompt);
}
