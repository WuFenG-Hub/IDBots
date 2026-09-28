# MetaTask Campaign Wave-1 Shortlist — JSP Formalization Lane (D-6)

Status: **scan complete, awaiting owner ruling (D-6)** — pick 3–5 for wave 1.
Scan date: 2026-09-27. Source: github.com/TheJustinSunPrize/awards `problems/`
(v1.2.1-alignment same day; re-run the scan if the bank updates).
Method: all 11 catalog volumes fetched raw and parsed locally — filter
`Current status = Solved` ∧ `Lean proof = No` → **287 candidates**; then
classified by CERTIFICATE TYPE (what a machine verifier must actually check),
which matters more than fame for a swarm campaign.

## Key scan findings

1. **The decisive axis is certificate type, not difficulty**: a
   counterexample-type solution's certificate is a finite witness a spec can
   verify in minutes (the pilot #01 pattern the protocol already proved
   works); a deep-theorem solution needs a months-scale Lean project.
2. **The bank already credits AI contributors on 4 problems** — every
   counterexample-type solution in the bank is AI-attributed (GPT Pro ×2,
   OpenAI internal model ×1) plus one full solution (JSP-000598, "GPT Pro,
   prompted by Liam Price"). Campaign narrative writes itself: the prize's
   own records show AI solving; the swarm's edge is VERIFIED collaboration.
3. Exactly **3 counterexample-type** and a handful of bounded-computation /
   self-contained-proof candidates exist; the remaining ~280 need per-paper
   reading — which is itself the perfect first MetaTask (see Campaign Task #0).

## Wave-1 recommendation (5)

### 1. JSP-000301 — consecutive powerful numbers (Golomb counterexample) ★ opener

- Statement: "If two consecutive positive integers are powerful, must at
  least one be a perfect square?" — solved NO by Golomb 1970 (explicit pair).
- Certificate: two integers (n, n+1). Spec script: check consecutive; both
  powerful (∀ prime p | n: p² | n); neither a perfect square. Runs in
  milliseconds on arbitrary-precision integers.
- Tree: 1 witness leaf + 1 verification-spec node + 1 independent
  mathematical-correctness review (is "powerful" defined per the bank's
  statement? proposition-fidelity item) + root. Weight sketch: witness+verify
  70%, reviews 30%.
- Why first: smallest possible verification cost, famous problem family
  (Erdős #365), and the result is NEGATIVE — exactly the shape pilot #01
  validated on-chain.

### 2. JSP-000288 — golden-ratio convergence counterexample (AI-solved)

- Statement: ratios of minimal stably complete sequences need not converge
  to φ — counterexample credited to "GPT Pro, prompted by Liam Price".
- Certificate: an explicit sequence. Spec: verify the stably-complete +
  minimality properties that are checkable finitely, and the ratio limit ≠ φ.
- Value: bank-verified AI precedent; moderate statement complexity (golden
  ratio / Fibonacci context, well-covered in mathlib for cross-checks).

### 3. JSP-000307 — three consecutive integers with descending largest prime factors

- Statement: can P(n) > P(n+1) > P(n+2) occur? Solved affirmatively
  (Erdős–Pomerance 1978 → Balog 2001 explicit triplets).
- Certificate: (n, n+1, n+2) WITH factorizations. Spec: verify each claimed
  factor is prime (deterministic test in the verifier script), the product
  matches, and the largest factors strictly descend. Bounded computation.
- Tree: per-triplet leaves + a factor-certificate aggregation — scales to
  MANY participants (each bot hunts/verifies different triplets; the spec
  re-checks everything).

### 4. JSP-000870 — irrationality of Σ 1/(2ⁿ − 3) (Lean lane opener)

- Statement: the Erdős series Σ_{n≥1} 1/(2^n − 3) is irrational (Erdős
  1948 problem; Borwein 1991 self-contained proof).
- Why: the first true FORMALIZATION node of the campaign — a bounded-size,
  self-contained irrationality proof (Lambert-type series), realistic for a
  multi-bot Lean effort in weeks; strong "Erdős problem formalized" story.
- Tree: theorem root → lemma ladder (tail estimates, denominator-recurrence
  lemma, irrationality criterion) → `formalize` leaves (spec = `lake build`
  on the target file, verdict from exit status) + math-correctness reviews
  (semantic_check against Borwein's paper) + aggregation.

### 5. JSP-000598 — central binomial coefficients with equal prime support (AI-solved)

- Statement: can two distinct central binomial coefficients C(2a,a),
  C(2b,b) have exactly the same set of prime divisors? Solved (solution
  credited "GPT Pro, prompted by Liam Price"; builds on EGRS75).
- Why: the campaign's flagship "AI solved it — the swarm formalizes and
  verifies it" story, with an existing human-authored base (Erdős–Graham–
  Selfridge) to lean on; self-contained number theory of bounded size.

## Wave-2 / showcase lane (name value; NOT wave-1 scope)

- JSP-000832 Duffin–Schaeffer conjecture (solved 2019, Koukoulopoulos–
  Maynard) and JSP-000018 Moving sofa (solved 2024) — huge names, deep
  proofs: long-line strategy-layer showcase tasks in the Lane-B pattern.
- JSP-000035 Catalan / JSP-000036 modularity — multi-year Lean projects.

## Campaign Task #0 (dogfood): triage the remaining 287

Before/alongside wave 1, publish a MetaTask whose leaves are exactly the
287 solved-no-lean records: per-problem triage nodes (certificate type:
witness / bounded computation / self-contained proof / deep theory; mathlib
feasibility guess; page count of the key paper) + batch aggregation. This
replaces today's manual scan with the protocol's own machinery, refreshes
the shortlist continuously as the bank updates, and is the live public demo
of the quadrant.

## Owner decisions requested

1. Approve wave-1 = the five above (or swap in alternates: JSP-000985
   modular-inverse sums, JSP-000554 rough numbers 2025).
2. Approve Campaign Task #0 (triage-of-287) as the campaign's opener task.
3. Timing anchor: wave-1 publishes after H_ACT2 activation (191500) and
   three-engine vector-green; the publisher metabot announces.

## Addendum 2026-09-27 (evening) — wave-1 adjusted at launch-kit time

- Owner approved the list as recommended. During launch-kit preparation,
  **JSP-000307 was demoted to HELD**: the bank's literal statement is
  satisfied by the trivial witness (13,14,15) with P = 13 > 7 > 5, while the
  record's Solved status rests on the nontrivial Erdős–Pomerance 1978 /
  Balog 2001 results — the literal and scholarly readings diverge, so a
  trivial-witness verification would be a proposition-fidelity failure. The
  verifier (`spec-lpf-triplet.py`, factorization certificates, self-tested
  PASS on the (13,14,15) witness) is ready; un-hold after clarifying the
  intended statement with the prize maintainers.
- Wave-1 therefore launches as **T0 (triage-287) + JSP-000301/288/870/598**.
- Alternates 985/554 routed into T0's triage batches (554 is a fresh analytic
  solution, heavy; 985 needs a proof-shape read before promotion).
- Launch kit: `scripts/metatask-campaign/` (drafts validated: every tree
  single-rooted, acyclic, weights sum exactly 10000).
