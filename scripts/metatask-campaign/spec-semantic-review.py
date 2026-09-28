#!/usr/bin/env python3
"""
spec-semantic-review.py — proposition-fidelity review submission checker
(MetaTask spec script, protocol v1.2.1 §spec contract). Used by triage-kind
review nodes (and by proof-kind nodes whose deliverable is a literature-aligned
restatement, e.g. T4 node `base`).

Node shape it judges: "review an on-chain deliverable against the INDEPENDENT
correspondence artifact cited by the task's spec.validation.proposition_fidelity
and report, item by item, whether the formalized statement / definitions /
proof direction still match the original proposition". This script closes the
machine-checkable part of that delivery: the artifact reference is a real pin
reference (never the unresolved publish placeholder), the protocol's three
correspondence items are all covered exactly once, each item carries a
substantive note, a `divergent` item carries evidence, and the summary verdict
agrees with the items.

Verdict semantics: `pass` means the review report is complete and well formed —
including a well-evidenced `divergent` report, which is a legitimate delivery
(it tells the publisher the task's proposition may not match the bank's
record). `fail` is reserved for malformed or incomplete reports. The substance
of the review (is the alignment claim true?) stays with the reviewer's
semantic_check, which the protocol routes to this same artifact.

Input (stdin, JSON):
  {
    "task": "T1-JSP-000301",
    "artifactPin": "metafile://...i0",
    "items": [
      { "id": "statement", "assessment": "aligned", "note": "..." },
      { "id": "definitions", "assessment": "aligned", "note": "..." },
      { "id": "proof-direction", "assessment": "divergent", "note": "...", "evidence": "..." }
    ],
    "reviewerVerdict": "divergent",
    "semanticCheck": "..."
  }
Output (stdout, JSON): { "verdict": "pass" | "fail" | "invalid", "detail": "..." }
Criteria (all must hold for pass):
  1) task is a non-empty string; artifactPin matches ^(pin://|metafile://)\\S+$
     and is NOT the publish-time placeholder PUBLISH_ARTIFACT_FIRST
  2) items is a non-empty array; ids unique; the three protocol items
     statement / definitions / proof-direction are all present
  3) every item: assessment in {aligned, divergent}; note a string of >= 20
     characters; a divergent item carries an evidence string of >= 10 characters
  4) reviewerVerdict in {aligned, divergent} and consistent with the items:
     any divergent item -> "divergent", none -> "aligned"
  5) semanticCheck is a string of >= 20 characters (the pointer the protocol
     tells reviewers to raise)
null/missing input, or a shape that cannot be judged -> verdict=invalid with the
offending location (protocol null_tolerance criterion).
"""
import json
import re
import sys

REQUIRED_ITEMS = ("statement", "definitions", "proof-direction")
ARTIFACT_RE = re.compile(r"^(pin://|metafile://)\S+$")
PLACEHOLDER = "PUBLISH_ARTIFACT_FIRST"
MIN_NOTE = 20
MIN_EVIDENCE = 10


def emit(verdict, detail, **extra):
    payload = {"verdict": verdict, "detail": detail}
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)


def main():
    try:
        raw = json.load(sys.stdin)
    except Exception as err:
        emit("invalid", "input json: %s" % err)
    if not isinstance(raw, dict):
        emit("invalid", "input must be an object")

    task = raw.get("task")
    if not isinstance(task, str) or not task.strip():
        emit("invalid", "task: missing or empty")

    artifact_pin = raw.get("artifactPin")
    if not isinstance(artifact_pin, str) or not artifact_pin.strip():
        emit("invalid", "artifactPin: missing or empty")
    if artifact_pin.strip() == PLACEHOLDER:
        emit("fail", "artifactPin: unresolved publish placeholder %s — the correspondence "
                     "artifact must be published and its pinId substituted before review" % PLACEHOLDER)
    if not ARTIFACT_RE.match(artifact_pin.strip()):
        emit("invalid", "artifactPin: must be a pin:// or metafile:// reference")

    items = raw.get("items")
    if not isinstance(items, list) or not items:
        emit("invalid", "items: missing or empty array")
    seen = set()
    assessments = {}
    for index, item in enumerate(items):
        where = "items[%d]" % index
        if not isinstance(item, dict):
            emit("invalid", "%s: not an object" % where)
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            emit("invalid", "%s.id: missing or empty" % where)
        if item_id in seen:
            emit("fail", "%s.id: duplicate item %s" % (where, item_id))
        seen.add(item_id)
        assessment = item.get("assessment")
        if assessment not in ("aligned", "divergent"):
            emit("invalid", "%s.assessment: must be aligned or divergent" % where)
        note = item.get("note")
        if not isinstance(note, str) or len(note.strip()) < MIN_NOTE:
            emit("fail", "%s.note: must be a substantive string (>= %d characters)" % (where, MIN_NOTE))
        if assessment == "divergent":
            evidence = item.get("evidence")
            if not isinstance(evidence, str) or len(evidence.strip()) < MIN_EVIDENCE:
                emit("fail", "%s: divergent item needs evidence (>= %d characters)" % (where, MIN_EVIDENCE))
        assessments[item_id] = assessment

    missing = [item_id for item_id in REQUIRED_ITEMS if item_id not in assessments]
    if missing:
        emit("fail", "items: missing required correspondence item(s): %s" % ", ".join(missing))

    reviewer_verdict = raw.get("reviewerVerdict")
    if reviewer_verdict not in ("aligned", "divergent"):
        emit("invalid", "reviewerVerdict: must be aligned or divergent")
    expected_verdict = "divergent" if "divergent" in assessments.values() else "aligned"
    if reviewer_verdict != expected_verdict:
        emit("fail", "reviewerVerdict %s disagrees with the item assessments (expected %s)"
                     % (reviewer_verdict, expected_verdict))

    semantic_check = raw.get("semanticCheck")
    if not isinstance(semantic_check, str) or len(semantic_check.strip()) < MIN_NOTE:
        emit("fail", "semanticCheck: must be a substantive string (>= %d characters)" % MIN_NOTE)

    print(json.dumps({
        "verdict": "pass",
        "detail": "review report complete for %s against %s: %d item(s), reviewer verdict %s"
                  % (task, artifact_pin, len(items), reviewer_verdict),
        "coveredItems": sorted(assessments),
        "expected_count": len(REQUIRED_ITEMS),
        "reviewerVerdict": reviewer_verdict,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
