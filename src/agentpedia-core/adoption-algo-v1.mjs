// Agentpedia adoption-algo-v1 — deterministic replay engine.
//
// Spec source (composite final state, latest-layer resolution; see replay-vectors.v1.json meta.sources):
//   v0.1   pin://bd28bfc0e9d2488005c85caa3aa77618d05623dc15273cc38f6d73c33b868b10i0
//   v0.1.1 pin://ab4224e2be9fe2e45cb927d286b14896a2c7009eb66b7aeee2f9dd391eb832eei0
//   v0.1.2 pin://79ee51b8528c93ecf9caffa1e5ae673a2421e15309b108958414b850400f6c6ai0
//   v0.1.3 pin://e4c9dfc82dbea89d0e5f8900f40112dee40dad324b3a50ad4a1221dc2cda048ai0
//   v0.1.5 pin://5f94460cb9e7f1078b0d3f8ed5608ec5dac1114207907cada58555a6e9d0b545i0
//   v0.1.6 pin://1f88cf0cf41a2974edc5df7231be908a66a0ba729bbb6b1fc1ed95c57c7db2c7i0
// v0.1.4 is voided by v0.1.5 and is never referenced.
//
// Determinism contract (spec v0.1 §13): chain order (genesisHeight, txIndex) is the only
// clock; mempool pins (genesisHeight < 0) are excluded until confirmed; amounts are
// integers; no payload timestamps.

import { createHash } from 'node:crypto';

export const ALGO_VERSION = 'adoption-algo-v1';

// reputation-algo-v1 deltas (engine constants; the vector set exercises direction only —
// magnitudes to be aligned when the reputation-algo-v1 constants are pinned on-chain).
export const REP_DELTAS = {
  'confirm-goodfaith': 1,
  'warn-editor': -1,
  'slash-stake-half': -2,
  'slash-stake-full': -5,
  'ban-editor': -5,
};

// arbiter-draw-v1 (spec v0.1 §13.4): key = first 8 bytes (big-endian) of
// sha256(seedPinId + editorGlobalMetaId); top-N keys join the arbiter set.
export function arbiterDrawV1(seedPinId, candidates, n) {
  const scored = candidates.map((id) => ({
    id,
    key: createHash('sha256').update(seedPinId + id).digest().readBigUInt64BE(0),
  }));
  scored.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return scored.slice(0, n).map((s) => s.id);
}

function sortEvents(events) {
  return events
    .map((e, seq) => ({ e, seq }))
    .sort((a, b) => {
      const ah = a.e.height ?? 0;
      const bh = b.e.height ?? 0;
      if (ah !== bh) return ah - bh;
      const at = a.e.txIndex ?? 0;
      const bt = b.e.txIndex ?? 0;
      if (at !== bt) return at - bt;
      return a.seq - b.seq;
    })
    .map((x) => x.e);
}

export function replay(inputEvents, options = {}) {
  const blocksPerHour = options.blocksPerHour ?? 6; // ~10 min blocks
  const blocksPerDay = options.blocksPerDay ?? 144;
  const arbiterOverrides = options.arbiterOverrides ?? {}; // proposalPin -> [arbiter ids]
  const frozenArbiterOverrides = options.frozenArbiterOverrides ?? {}; // entryKey -> [ids]
  // v0.1.2 D4 cluster merging: same-controller MetaIDs share rate/edit-war counters.
  const clusterAliases = options.clusterAliases ?? {}; // aliasId -> rootId
  const countRoot = (id) => clusterAliases[id] ?? id;

  const pending = []; // mempool pins, excluded until confirmed (F6)
  const confirmed = [];
  for (const e of inputEvents) {
    if (e.height == null || e.height < 0) pending.push(e.pin);
    else confirmed.push(e);
  }
  const events = sortEvents(confirmed);

  // ----- state -----
  let params = null;
  let genesisHeight = null;
  let bootstrapEndH = Infinity;
  let founders = [];
  const editors = new Map(); // id -> {founder, registeredAt, registerH, stake, endorsements:Set, reputation, validRevs, suspensionUntil, revoked, banned, regChallengeH, pocH}
  const entries = new Map(); // entryKey -> view entry
  const graveyard = [];
  const challenges = new Map(); // challengePin -> {targetRev, challenger, entryKey}
  const proposals = new Map(); // proposalPin -> {...}
  const paramProposals = new Map();
  const reviewsByTarget = new Map(); // targetRev -> [{reviewer}]
  const regChallenges = new Map(); // challengePin (editor path) -> {applicant, challenger, h, pocH, pocOk, stakeOk, registerH}
  const editorRegs = new Map(); // applicant -> challengePin

  const editorOf = (id) => {
    if (!editors.has(id)) {
      editors.set(id, {
        founder: false, registeredAt: null, registerH: null, endorsements: new Set(),
        reputation: 0, validRevs: 0, suspensionUntil: null, revoked: false, banned: false,
      });
    }
    return editors.get(id);
  };

  const entryOf = (key) => {
    if (!entries.has(key)) {
      entries.set(key, {
        head: null, status: 'normal', history: [], disputed: new Set(), contests: [],
        versions: new Map(), redirect: null, frozenAt: null, baselineRev: null,
        frozenArbiters: null, revertWeights: [],
      });
    }
    return entries.get(key);
  };

  const graveyardIt = (pin, reason) => graveyard.push({ pin, reason });

  // E-5 candidate (JS twin of the Go rule): entryKey attribution is a write-time
  // fact — every rev records the entryKey it was written under (version.entryKey).
  // Never resolve by Map iteration order.
  const entryKeyOfRev = (rev) => {
    if (!rev) return null;
    let recorded = null;
    for (const en of entries.values()) {
      const v = en.versions.get(rev);
      if (v) { recorded = v.entryKey; break; }
    }
    if (recorded && entries.get(recorded)?.versions.has(rev)) return recorded;
    const keys = [];
    for (const [k, en] of entries.entries()) if (en.versions.has(rev)) keys.push(k);
    if (keys.length === 0) return null;
    keys.sort();
    return keys[0];
  };

  const tierOf = (id, h) => {
    const ed = editors.get(id);
    if (!ed || ed.revoked || ed.banned || ed.registeredAt == null) return null;
    if (ed.suspensionUntil != null && h < ed.suspensionUntil) return null;
    const ageH = (h - ed.registeredAt) / blocksPerHour;
    const ageDays = (h - ed.registeredAt) / blocksPerDay;
    const bootstrapping = h < bootstrapEndH;
    if (ed.founder && bootstrapping) return 'T2'; // v0.1.2 D7.3 + v0.1.3 §3: founder T2 only inside bootstrap window
    if (ageDays >= params.t2MinDays && ed.validRevs >= params.t2MinValidRevs) return 'T2';
    // E-2 (pin://892ce8b2889cf20d2901dc955182b0674c5c7c85eccc055230bef205f377cca3i0;
    // ruling pin://66518de4898e00912744afd2b562c99eab3225983139afd24828362e0d53031ci0):
    // layered authorization — T0 expiry restores the basic edit right; t1MinValidRevs
    // only marks the T1 identity tier and never gates basic rights.
    if (ed.founder && bootstrapping) return 'T2'; // v0.1.2 D7.3 + v0.1.3 §3: founder T2 only inside bootstrap window
    if (ageDays >= params.t2MinDays && ed.validRevs >= params.t2MinValidRevs) return 'T2';
    if (ageH >= params.t0DurationHours && ed.validRevs >= params.t1MinValidRevs) return 'T1';
    if (ageH >= params.t0DurationHours) return 'T0+'; // basic edit right active, T1 marker not yet met
    return 'T0';
  };
  const isActive = (id, h) => tierOf(id, h) != null;
  const isArbiterCandidate = (id, h) => tierOf(id, h) === 'T2';

  const dayOf = (h) => Math.floor((h - genesisHeight) / blocksPerDay);
  const dayGlobal = new Map(); // `${editor}|${day}` -> applied rev count
  const daySlug = new Map(); // `${editor}|${day}|${entryKey}` -> applied rev count

  const closeExpiredProposals = (h) => {
    for (const p of proposals.values()) {
      if (p.state === 'open' && h >= p.expiryH) {
        // v0.1.1 X6/X7: window expiry without quorum -> voided; frozen-entry proposal
        // carries validated baselineRev -> neutral auto-revert, no new pin.
        p.state = 'voided';
        if (p.entryKey != null) {
          const en = entries.get(p.entryKey);
          if (en && en.status === 'frozen' && p.baselineRev != null) {
            en.head = p.baselineRev;
            en.status = 'normal';
          } else if (en && en.status === 'frozen') {
            en.status = 'normal';
          }
        }
      }
    }
  };

  const applyOutcome = (p) => {
    p.state = 'effective';
    if (p.entryKey != null) {
      const en = entries.get(p.entryKey);
      switch (p.outcome) {
        case 'dismiss': {
          const ch = challenges.get(p.challengePin);
          if (ch) en.disputed.delete(ch.targetRev);
          break;
        }
        case 'revert-to': {
          const target = en.versions.get(p.params.revertTo);
          const eq = p.pin + '::rev';
          en.versions.set(eq, {
            contentHash: target ? target.contentHash : null,
            author: p.proposer, parentRev: en.head, entryKey: p.entryKey, equivalentOf: p.pin,
          });
          en.head = eq;
          en.history.push(eq);
          break;
        }
        case 'protect': en.status = 'protected'; break;
        case 'unprotect': en.status = 'normal'; break;
        case 'unfreeze': if (en.status === 'frozen') en.status = 'normal'; break;
        case 'transfer-slug': {
          const from = entries.get(p.params.fromEntry);
          if (from) {
            entries.set(p.params.toEntry, from);
            from.redirect = { to: p.params.toEntry.split(':').slice(1).join(':') };
          }
          break;
        }
        default: break;
      }
    }
    const delta = REP_DELTAS[p.outcome];
    if (delta && p.params && p.params.editor) {
      editorOf(p.params.editor).reputation += delta;
    }
    if (p.outcome === 'ban-editor' && p.params && p.params.editor) {
      editorOf(p.params.editor).banned = true;
    }
  };

  const snapshotArbiters = (p, h) => {
    if (arbiterOverrides[p.pin]) return [...arbiterOverrides[p.pin]];
    const candidates = [...editors.keys()].filter((id) => isArbiterCandidate(id, h));
    return arbiterDrawV1(p.challengePin, candidates, params.arbiterDrawN);
  };

  // ----- rev helpers -----
  const checkRevGates = (e, en, h) => {
    if (!isActive(e.sender, h)) return 'unregistered';
    if (tierOf(e.sender, h) === 'T0') return 't0-no-rev'; // E-2: T0 window is read+review only
    if (en.status === 'frozen') {
      const arb = en.frozenArbiters ?? [];
      if (!arb.includes(e.sender)) return 'frozen-unauthorized';
    }
    if (en.status === 'protected') {
      const tier = tierOf(e.sender, h);
      const ed = editors.get(e.sender);
      const repOk = ed && ed.reputation >= params.thetaProtect;
      if (!(tier === 'T2' && repOk)) return 'protected-unauthorized'; // v0.1.3 §1 conjunction
    }
    const day = dayOf(h);
    const root = countRoot(e.sender); // D4: cluster-merged counting
    const gk = `${root}|${day}`;
    const sk = `${gk}|${e.entryKey}`;
    if ((dayGlobal.get(gk) ?? 0) + 1 > params.rateGlobalDaily) return 'rate-global';
    if ((daySlug.get(sk) ?? 0) + 1 > params.ratePerSlugDaily) return 'rate-slug';
    return null;
  };
  const countRev = (e, en, h) => {
    const day = dayOf(h);
    const root = countRoot(e.sender); // D4: cluster-merged counting
    const gk = `${root}|${day}`;
    const sk = `${gk}|${en.key ?? ''}`;
    dayGlobal.set(gk, (dayGlobal.get(gk) ?? 0) + 1);
    daySlug.set(sk, (daySlug.get(sk) ?? 0) + 1);
    editorOf(e.sender).validRevs += 1;
  };

  const revertWeight = (en, e) => {
    // v0.1.2 §3 (D3) + v0.1.5 §3 (F-1 final): plain revert 1.0; vandalism-fix 0.5;
    // repeat vandalism-fix by the SAME editor (cluster root, D4) on the SAME entry
    // restores 1.0.
    if (e.payload.claim && e.payload.claim.changeType === 'vandalism-fix') {
      const repeated = en.revertWeights.some((w) => w.editor === countRoot(e.sender) && w.vf);
      return repeated ? 1 : 0.5;
    }
    return 1;
  };

  // ----- main loop -----
  for (const ev of events) {
    const h = ev.height;
    closeExpiredProposals(h);
    const payload = ev.payload ?? {};
    const path = ev.path ?? '';

    if (path === '/protocols/agentpedia/constitution') {
      if (payload.revision === 0) {
        if (params != null) { graveyardIt(ev.pin, 'duplicate-genesis'); continue; }
        params = { ...payload.params };
        genesisHeight = h;
        founders = [...(payload.founders ?? [])];
        bootstrapEndH = h + (params.bootstrapWindowDays ?? 30) * blocksPerDay;
        for (const f of founders) {
          const ed = editorOf(f);
          ed.founder = true;
          ed.registeredAt = h;
        }
        for (const [id, rep] of Object.entries(options.editorsRep ?? {})) {
          editorOf(id).reputation = rep; // scenario-injected reputation baselines (vectors)
        }
      } else {
        const pp = paramProposals.get(payload.proposalPin);
        if (!pp || pp.state !== 'effective') { graveyardIt(ev.pin, 'constitution-without-effective-proposal'); continue; }
        params = { ...params, ...payload.params };
      }
      continue;
    }

    if (params == null) { graveyardIt(ev.pin, 'no-genesis'); continue; }

    if (path === '/protocols/agentpedia/editor') {
      const applicant = payload.editor;
      editorOf(applicant); // failed applicants stay visible in the registry view (audit)
      switch (payload.action) {
        case 'challenge': {
          if (!isActive(ev.sender, h)) { graveyardIt(ev.pin, 'unregistered'); break; }
          regChallenges.set(ev.pin, { applicant, challenger: ev.sender, h });
          editorRegs.set(applicant, ev.pin);
          break;
        }
        case 'poc-response': {
          const rc = regChallenges.get(payload.challengePin);
          if (!rc || rc.applicant !== ev.sender) { graveyardIt(ev.pin, 'poc-challenge-mismatch'); break; }
          if (h - rc.h > blocksPerHour) { graveyardIt(ev.pin, 'poc-window-exceeded'); break; } // 60 min
          const rv = (reviewsByTarget.get('::all') ?? []).find((r) => r.pin === payload.responsePin && r.reviewer === ev.sender);
          if (!rv) { graveyardIt(ev.pin, 'poc-response-missing'); break; }
          rc.pocH = h; rc.pocOk = true;
          break;
        }
        case 'register': {
          const rc = regChallenges.get(payload.challengePin);
          if (!rc || rc.applicant !== ev.sender || !rc.pocOk) { graveyardIt(ev.pin, 'register-invalid'); break; }
          if (!payload.stake || payload.stake.amountSat < params.stakeAmountSat) { graveyardIt(ev.pin, 'stake-insufficient'); break; }
          rc.stakeOk = true; rc.registerH = h;
          rc.registerTxIndex = ev.txIndex ?? 0; // E-4 R2: chain position for the deterministic fallback
          rc.registerPin = ev.pin;              // E-4 R1: the register this challenge's endorse names
          const ed = editorOf(ev.sender);
          ed.registerH = h; // age counts from register pin (v0.1.2 D2 "注册起")
          break;
        }
        case 'endorse': {
          if (!isActive(ev.sender, h) || tierOf(ev.sender, h) !== 'T2') { graveyardIt(ev.pin, 'endorser-not-t2'); break; }
          // E-4 R1: the target register is named by the event's own registerPin
          // (schema-required, v0.1 §7). Only when it is absent or does not resolve
          // do we fall back to a deterministic total order — never to Map
          // insertion order.
          const declared = payload.registerPin ?? null;
          let target = null;
          if (declared) {
            for (const rc of regChallenges.values()) {
              if (rc.applicant === applicant && rc.stakeOk && rc.registerPin === declared) { target = rc; break; }
            }
          }
          if (!target) {
            // E-4 R2 fallback: earliest (registerH, registerTxIndex), then the
            // lexicographically smallest register pin. Total order — no container
            // iteration order.
            for (const rc of regChallenges.values()) {
              if (rc.applicant !== applicant || !rc.stakeOk) continue;
              const better = target == null
                || rc.registerH < target.registerH
                || (rc.registerH === target.registerH && (rc.registerTxIndex ?? 0) < (target.registerTxIndex ?? 0))
                || (rc.registerH === target.registerH && (rc.registerTxIndex ?? 0) === (target.registerTxIndex ?? 0) && rc.registerPin < target.registerPin);
              if (better) target = rc;
            }
          }
          if (!target) { graveyardIt(ev.pin, 'endorse-no-register'); break; }
          if (ev.sender === applicant) { graveyardIt(ev.pin, 'self-endorse'); break; }
          const ed = editorOf(applicant);
          const before = ed.endorsements.size;
          ed.endorsements.add(ev.sender);
          if (ed.endorsements.size === before) { graveyardIt(ev.pin, 'duplicate-endorse'); break; }
          const threshold = h < bootstrapEndH ? 4 : 2; // v0.1.2 D7.2
          if (ed.endorsements.size >= threshold && ed.registeredAt == null) {
            // E-4 §四.2: aligned with the Go engine — registeredAt is the declared
            // (or fallback-selected) register's height, unconditionally.
            ed.registeredAt = target.registerH;
          }
          break;
        }
        case 'suspend': {
          const p = proposals.get(payload.rulingPin);
          if (!p || p.state !== 'effective' || !isArbiterCandidate(ev.sender, h)) { graveyardIt(ev.pin, 'suspend-unauthorized'); break; }
          editorOf(applicant).suspensionUntil = h + (params.arbiterSuspensionDays ?? 30) * blocksPerDay;
          break;
        }
        case 'revoke': {
          const p = proposals.get(payload.rulingPin);
          if (!p || p.state !== 'effective' || !isArbiterCandidate(ev.sender, h)) { graveyardIt(ev.pin, 'revoke-unauthorized'); break; }
          editorOf(applicant).revoked = true;
          break;
        }
        default: graveyardIt(ev.pin, 'editor-action-unknown');
      }
      continue;
    }

    if (path === '/protocols/agentpedia/review') {
      // No registered-reviewer gate here: the registration PoC is itself a review pinned
      // by the NOT-yet-registered applicant (v0.1 §7.2), so membership enforcement
      // belongs at consumption points (featured scoring), not at record time.
      const revKey = entryKeyOfRev(payload.targetRev);
      const targetEntry = revKey ? entries.get(revKey) : null;
      if (!targetEntry) { graveyardIt(ev.pin, 'review-target-unresolvable'); continue; }
      if (targetEntry.versions.get(payload.targetRev).author === ev.sender) { graveyardIt(ev.pin, 'self-review'); continue; }
      const list = reviewsByTarget.get(payload.targetRev) ?? [];
      list.push({ reviewer: ev.sender, pin: ev.pin, payload });
      reviewsByTarget.set(payload.targetRev, list);
      const all = reviewsByTarget.get('::all') ?? [];
      all.push({ pin: ev.pin, reviewer: ev.sender, payload });
      reviewsByTarget.set('::all', all);
      continue;
    }

    if (path === '/protocols/agentpedia/challenge') {
      const entryKey = `${payload.lang ?? ''}`;
      const targetKey = entryKeyOfRev(payload.targetRev);
      const targetEntry = targetKey ? entries.get(targetKey) : null;
      if (!targetEntry) { graveyardIt(ev.pin, 'challenge-target-unresolvable'); continue; }
      if (!isActive(ev.sender, h)) { graveyardIt(ev.pin, 'unregistered'); continue; }
      if (targetEntry.versions.get(payload.targetRev).author === ev.sender) { graveyardIt(ev.pin, 'self-challenge'); continue; }
      targetEntry.disputed.add(payload.targetRev);
      challenges.set(ev.pin, { targetRev: payload.targetRev, challenger: ev.sender, entryKey: targetKey });
      continue;
    }

    if (path === '/protocols/agentpedia/ruling') {
      if (payload.action === 'proposal') {
        if (!isActive(ev.sender, h)) { graveyardIt(ev.pin, 'unregistered'); continue; }
        const ch = challenges.get(payload.challengePin);
        if (!ch) { graveyardIt(ev.pin, 'ruling-challenge-missing'); continue; }
        if (payload.seed !== payload.challengePin) { graveyardIt(ev.pin, 'ruling-seed-mismatch'); continue; }
        const en = entries.get(ch.entryKey);
        // v0.1.1 §2.1: baselineRev conditional — required iff entry frozen, must equal
        // the engine-computed pre-trigger head; must be null otherwise.
        let baselineRev = null;
        if (en.status === 'frozen') {
          if (payload.baselineRev == null || payload.baselineRev !== en.baselineRev) {
            graveyardIt(ev.pin, 'baseline-rev-mismatch'); continue;
          }
          baselineRev = payload.baselineRev;
        } else if (payload.baselineRev != null) {
          graveyardIt(ev.pin, 'baseline-rev-not-null'); continue;
        }
        const needs = {
          'revert-to': (q) => q.params && q.params.revertTo && en.versions.has(q.params.revertTo),
          'transfer-slug': (q) => q.params && q.params.fromEntry && q.params.toEntry,
          'warn-editor': (q) => q.params && q.params.editor,
          'slash-stake-half': (q) => q.params && q.params.editor,
          'slash-stake-full': (q) => q.params && q.params.editor,
          'ban-editor': (q) => q.params && q.params.editor,
          'confirm-goodfaith': (q) => q.params && q.params.editor,
          'protect': (q) => q.params && typeof q.params.protected === 'boolean',
          'unprotect': (q) => q.params && typeof q.params.protected === 'boolean',
          'dismiss': () => true,
          'unfreeze': () => true,
        };
        if (!needs[payload.outcome]?.(payload)) { graveyardIt(ev.pin, 'ruling-params-missing'); continue; }
        const p = {
          pin: ev.pin, challengePin: payload.challengePin, outcome: payload.outcome,
          params: payload.params ?? {}, proposer: ev.sender, height: h,
          expiryH: h + (params.voteWindowHours ?? 48) * blocksPerHour,
          arbiters: null, approves: new Set(), approveCount: 0, state: 'open',
          entryKey: ch.entryKey, baselineRev,
        };
        p.arbiters = snapshotArbiters(p, h);
        proposals.set(ev.pin, p);
        continue;
      }
      if (payload.action === 'vote') {
        const p = proposals.get(payload.proposalPin);
        if (!p || p.state !== 'open' || h > p.expiryH) { graveyardIt(ev.pin, 'vote-on-closed-proposal'); continue; }
        if (p.voters && p.voters.has(ev.sender)) { graveyardIt(ev.pin, 'duplicate-vote'); continue; }
        (p.voters ??= new Set()).add(ev.sender);
        // approval-only (v0.1.1 X6): snapshot arbiters' approve counts; everything else
        // is recorded for audit but never counts (V15-R/V24).
        if (payload.approve === true && p.arbiters.includes(ev.sender)) {
          p.approves.add(ev.sender);
          p.approveCount = p.approves.size;
          if (p.approveCount >= (params.rulingQuorum ?? 5)) applyOutcome(p);
        }
        continue;
      }
      graveyardIt(ev.pin, 'ruling-action-unknown');
      continue;
    }

    if (path === '/protocols/agentpedia/param-proposal') {
      if (payload.kind === 'proposal') {
        if (!isActive(ev.sender, h)) { graveyardIt(ev.pin, 'unregistered'); continue; }
        paramProposals.set(ev.pin, {
          pin: ev.pin, target: payload.targetConstitution, changes: payload.changes,
          proposer: ev.sender, height: h, approves: new Set(),
          expiryH: h + (params.challengeWindowHours ?? 72) * blocksPerHour,
          state: 'open',
        });
        continue;
      }
      if (payload.kind === 'vote') {
        const pp = paramProposals.get(payload.proposalPin);
        if (!pp || pp.state !== 'open' || h > pp.expiryH) { graveyardIt(ev.pin, 'param-vote-on-closed'); continue; }
        if (payload.approve === true && isArbiterCandidate(ev.sender, h)) pp.approves.add(ev.sender);
        const need = Math.ceil((2 / 3) * (params.arbiterPoolK ?? 21)); // spec v0.1 §9: 14 of 21
        if (pp.approves.size >= need) pp.state = 'effective';
        continue;
      }
      graveyardIt(ev.pin, 'param-proposal-kind-unknown');
      continue;
    }

    if (path === '/protocols/agentpedia/rev') {
      const entryKey = `${payload.lang}:${payload.slug}`;
      const en = entryOf(entryKey);
      en.key = entryKey;
      const type = payload.type;

      const gate = checkRevGates(ev, en, h);
      if (gate) { graveyardIt(ev.pin, gate); continue; }

      if (type === 'create') {
        if (en.head != null) { graveyardIt(ev.pin, 'duplicate-create'); continue; } // V18 orphan
        en.head = ev.pin;
        en.history.push(ev.pin);
        en.versions.set(ev.pin, { contentHash: payload.contentHash, author: ev.sender, parentRev: null, entryKey });
        countRev(ev, en, h);
        continue;
      }
      if (type === 'edit') {
        if (en.head == null) { graveyardIt(ev.pin, 'edit-without-entry'); continue; }
        const prevHead = en.head;
        if (payload.basedOn != null && payload.basedOn !== prevHead) {
          en.contests.push({ pin: ev.pin, expected: prevHead, declared: payload.basedOn }); // v0.1 §3.2.3
        }
        en.head = ev.pin;
        en.history.push(ev.pin);
        en.versions.set(ev.pin, { contentHash: payload.contentHash, author: ev.sender, parentRev: payload.parentRev ?? null, entryKey });
        countRev(ev, en, h);
        continue;
      }
      if (type === 'revert') {
        if (en.head == null) { graveyardIt(ev.pin, 'revert-without-entry'); continue; }
        let target = en.versions.get(payload.revertTo);
        if (!target) {
          // distinguish a truly missing target from a cross-entry revert (V05)
          let cross = false;
          for (const other of entries.values()) {
            if (other.versions.has(payload.revertTo)) { cross = true; break; }
          }
          graveyardIt(ev.pin, cross ? 'revert-entry-mismatch' : 'revert-target-unresolvable');
          continue;
        }
        if (target.entryKey !== entryKey) { graveyardIt(ev.pin, 'revert-entry-mismatch'); continue; }
        if (payload.contentHash !== target.contentHash) { graveyardIt(ev.pin, 'revert-hash-mismatch'); continue; } // V06
        const preHead = en.head;
        const eq = ev.pin + '::eq';
        en.versions.set(eq, {
          contentHash: target.contentHash, author: ev.sender, parentRev: preHead,
          entryKey, equivalentOf: ev.pin,
        });
        en.head = eq;
        en.history.push(eq);
        countRev(ev, en, h);
        // edit-war window accounting (v0.1.2 §3 weights, v0.1.5 §1 sole criterion)
        const winH = (params.revertWarWindowHours ?? 6) * blocksPerHour;
        const w = revertWeight(en, ev);
        en.revertWeights.push({ h, editor: countRoot(ev.sender), weight: w, vf: ev.payload.claim?.changeType === 'vandalism-fix' });
        en.revertWeights = en.revertWeights.filter((x) => x.h > h - winH);
        const cumulative = en.revertWeights.reduce((s, x) => s + x.weight, 0);
        if (en.status === 'normal' && cumulative >= (params.revertWarThreshold ?? 3)) {
          en.status = 'frozen';
          en.frozenAt = ev.pin;
          en.baselineRev = preHead; // last normal head before the triggering event
          en.frozenArbiters = frozenArbiterOverrides[entryKey]
            ?? arbiterDrawV1(ev.pin, [...editors.keys()].filter((id) => isArbiterCandidate(id, h)), params.arbiterDrawN ?? 7);
        }
        continue;
      }
      if (type === 'redirect') {
        if (en.head == null) { graveyardIt(ev.pin, 'redirect-without-entry'); continue; }
        const targetKey = `${payload.lang}:${payload.redirectTo}`;
        const target = entries.get(targetKey);
        if (!target || target.head == null) { graveyardIt(ev.pin, 'redirect-target-missing'); continue; } // V19
        en.head = ev.pin;
        en.history.push(ev.pin);
        en.redirect = { to: payload.redirectTo };
        countRev(ev, en, h);
        continue;
      }
      graveyardIt(ev.pin, 'rev-type-unknown');
      continue;
    }

    graveyardIt(ev.pin, 'unknown-path');
  }

  closeExpiredProposals((events[events.length - 1]?.height ?? 0) + 1);

  // ----- view -----
  const view = { entries: {}, graveyard, pending: [...pending], editors: {}, proposals: {}, params, founders };
  for (const [key, en] of entries.entries()) {
    if (en.history.length === 0 && en.head == null) continue; // never-touched bucket
    view.entries[key] = {
      head: en.head,
      status: en.status,
      history: [...en.history],
      disputed: [...en.disputed],
      contests: en.contests.map((c) => ({ ...c })),
      redirect: en.redirect,
      frozenAt: en.frozenAt,
      baselineRev: en.baselineRev,
      versions: Object.fromEntries([...en.versions.entries()].map(([k, v]) => [k, { ...v }])),
    };
  }
  for (const [id, ed] of editors.entries()) {
    view.editors[id] = {
      status: ed.registeredAt != null ? 'active' : (ed.registerH != null ? 'pending' : 'none'),
      tier: tierOf(id, events[events.length - 1]?.height ?? 0),
      reputation: ed.reputation,
      validRevs: ed.validRevs,
      registeredAt: ed.registeredAt,
      revoked: ed.revoked,
      banned: ed.banned,
    };
  }
  for (const [pin, p] of proposals.entries()) {
    view.proposals[pin] = {
      state: p.state, outcome: p.outcome, approveCount: p.approveCount,
      arbiters: p.arbiters, entryKey: p.entryKey, baselineRev: p.baselineRev,
    };
  }
  return view;
}
