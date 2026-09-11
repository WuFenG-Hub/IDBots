import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptDecision, exampleRequest, type Decision } from '../src/renderer/features/proposals/model.ts';
const decision: Decision = { requestId: exampleRequest.id, version: 1, optionId: 'gallery', headline: ' My studio ', color: '#52796F', notes: 'Keep it simple', submittedAt: '2026-09-07T00:00:00Z' };
test('accepts edited fields and preserves request provenance', () => { const result = acceptDecision(exampleRequest, null, decision); assert.equal(result.headline, 'My studio'); assert.equal(result.notes, decision.notes); assert.equal(result.requestId, exampleRequest.id); });
test('duplicate submissions retain the original decision', () => { const first = acceptDecision(exampleRequest, null, decision); assert.equal(acceptDecision(exampleRequest, first, { ...decision, optionId: 'editorial' }), first); });
test('rejects outdated version, unknown option, blank headline and invalid color', () => { for (const patch of [{ version: 0 }, { optionId: 'missing' }, { headline: ' ' }, { color: 'url(x)' }]) assert.throws(() => acceptDecision(exampleRequest, null, { ...decision, ...patch })); });
