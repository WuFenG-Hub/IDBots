export type Proposal = { id: string; name: string; description: string; benefit: string; tradeoff: string; layout: 'editorial' | 'gallery' | 'dashboard'; color: string; headline: string };
export type Decision = { requestId: string; version: number; optionId: string; headline: string; color: string; notes: string; submittedAt: string };
export type ProposalRequest = { id: string; version: number; title: string; options: Proposal[] };
export function validateDecision(request: ProposalRequest, decision: Decision): boolean {
  return decision.requestId === request.id && decision.version === request.version
    && request.options.some(option => option.id === decision.optionId)
    && typeof decision.headline === 'string' && decision.headline.trim().length > 0 && decision.headline.length <= 100
    && /^#[0-9a-f]{6}$/i.test(decision.color) && typeof decision.notes === 'string' && decision.notes.length <= 2000;
}
export function acceptDecision(request: ProposalRequest, previous: Decision | null, decision: Decision): Decision {
  if (previous) return previous;
  if (!validateDecision(request, decision)) throw new Error('Invalid or outdated proposal decision');
  return { ...decision, headline: decision.headline.trim() };
}
export const exampleRequest: ProposalRequest = { id: 'homepage-demo', version: 1, title: 'A home for your ideas.', options: [
  { id: 'editorial', name: 'Editorial', description: 'A quiet, story-first homepage with generous space.', benefit: 'Best for writing and a personal introduction', tradeoff: 'Fewer projects visible at first glance', layout: 'editorial', color: '#B46B45', headline: 'Ideas worth sharing.' },
  { id: 'gallery', name: 'Gallery', description: 'Let your work lead. A visual collection that grows with you.', benefit: 'Best for projects, experiments and MetaApps', tradeoff: 'Needs strong cover images', layout: 'gallery', color: '#52796F', headline: 'A little curiosity. A lot of making.' },
  { id: 'dashboard', name: 'Workspace', description: 'An active home for projects, notes and recent activity.', benefit: 'Best for frequent updates and useful links', tradeoff: 'More information to maintain', layout: 'dashboard', color: '#657DA6', headline: 'Everything in motion.' },
] };
