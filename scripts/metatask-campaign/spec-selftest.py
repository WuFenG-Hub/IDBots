#!/usr/bin/env python3
"""
spec-selftest.py — runs every verifier script in this directory on its
documented sample input and asserts the expected verdict.

Usage:
  python3 scripts/metatask-campaign/spec-selftest.py

Exit code 0 = every case matched; non-zero = at least one case failed.
The cases below are the documented samples from each script's docstring plus the
boundary cases the runbook claims are covered (null/missing -> invalid,
non-powerful / square / non-consecutive -> fail, coverage mismatch -> fail).
No network and no Lean toolchain required.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

TRIAGE_BATCH_01_IDS = [
    "JSP-000007", "JSP-000018", "JSP-000035", "JSP-000036", "JSP-000045",
    "JSP-000060", "JSP-000076", "JSP-000077", "JSP-000078", "JSP-000085",
    "JSP-000087", "JSP-000089", "JSP-000090", "JSP-000093", "JSP-000096",
]


def triage_batch(ids, expected=None):
    return {
        "from": 1,
        "to": 100,
        "expected": len(ids) if expected is None else expected,
        "records": [
            {
                "jsp": jsp,
                "certificateType": "deep-theory",
                "mathlibFeasibility": "unknown",
                "keyPaperPages": None,
                "notes": "selftest placeholder row",
            }
            for jsp in ids
        ],
    }


WITNESS_EXTRACTION_OK = {
    "jsp": "JSP-000301",
    "claim": {"n": 12167, "m": 12168},
    "provenance": {
        "reference": "Solomon W. Golomb, Powerful numbers, Amer. Math. Monthly 77(8) (1970), 848-852",
        "locator": "https://doi.org/10.2307/2317020",
        "recordField": "JSP-000301 review note (Record correction, source review 2026-09-13)",
        "quotedText": "Disproved: 12167 = 23\u00b3 and 12168 = 2\u00b3 \u00d7 3\u00b2 \u00d7 13\u00b2 are consecutive powerful numbers, and neither is a perfect square.",
    },
    "factorization": {"n": [[23, 3]], "m": [[2, 3], [3, 2], [13, 2]]},
}

SEMANTIC_REVIEW_ALIGNED = {
    "task": "T1-JSP-000301",
    "artifactPin": "metafile://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefi0",
    "items": [
        {"id": "statement", "assessment": "aligned", "note": "Formalized statement is the record's yes/no question verbatim."},
        {"id": "definitions", "assessment": "aligned", "note": "Powerful = every prime exponent at least two, per the record's own review note."},
        {"id": "proof-direction", "assessment": "aligned", "note": "Counterexample direction: a single explicit pair refutes the question."},
    ],
    "reviewerVerdict": "aligned",
    "semanticCheck": "Compared the artifact's three items against the bank record; all three stay within the record's stated scope.",
}

SEMANTIC_REVIEW_DIVERGENT = json.loads(json.dumps(SEMANTIC_REVIEW_ALIGNED))
SEMANTIC_REVIEW_DIVERGENT["items"][1]["assessment"] = "divergent"
SEMANTIC_REVIEW_DIVERGENT["items"][1]["evidence"] = "Record review note adds 'not the separate counting question in Erdos problem #365'."
SEMANTIC_REVIEW_DIVERGENT["reviewerVerdict"] = "divergent"

SEMANTIC_REVIEW_NO_EVIDENCE = json.loads(json.dumps(SEMANTIC_REVIEW_DIVERGENT))
del SEMANTIC_REVIEW_NO_EVIDENCE["items"][1]["evidence"]

SEMANTIC_REVIEW_MISSING_ITEM = json.loads(json.dumps(SEMANTIC_REVIEW_ALIGNED))
SEMANTIC_REVIEW_MISSING_ITEM["items"] = [SEMANTIC_REVIEW_MISSING_ITEM["items"][0], SEMANTIC_REVIEW_MISSING_ITEM["items"][2]]

SEMANTIC_REVIEW_PLACEHOLDER = json.loads(json.dumps(SEMANTIC_REVIEW_ALIGNED))
SEMANTIC_REVIEW_PLACEHOLDER["artifactPin"] = "PUBLISH_ARTIFACT_FIRST"

# (name, script, stdin payload, expected verdict out of the script)
CASES = [
    ("triage-table: full b01 batch (15 rows)", "spec-triage-table.py", triage_batch(TRIAGE_BATCH_01_IDS), "pass"),
    ("triage-table: coverage mismatch (14 rows vs expected 15)", "spec-triage-table.py", triage_batch(TRIAGE_BATCH_01_IDS[:-1], expected=15), "fail"),
    ("triage-table: duplicate jsp", "spec-triage-table.py", triage_batch(TRIAGE_BATCH_01_IDS + ["JSP-000007"]), "fail"),
    ("triage-table: jsp outside batch range", "spec-triage-table.py", triage_batch(TRIAGE_BATCH_01_IDS + ["JSP-000101"]), "fail"),
    ("triage-table: bad certificateType", "spec-triage-table.py", {**triage_batch(TRIAGE_BATCH_01_IDS), "records": [{**triage_batch(TRIAGE_BATCH_01_IDS)["records"][0], "certificateType": "vibes"}]}, "fail"),
    ("triage-table: missing expected field", "spec-triage-table.py", {"from": 1, "to": 100, "records": []}, "invalid"),
    ("triage-table: empty object", "spec-triage-table.py", {}, "invalid"),

    ("powerful-pair: recorded pair (12167, 12168)", "spec-powerful-pair.py", {"n": 12167, "m": 12168}, "pass"),
    ("powerful-pair: (8, 9) has a square member", "spec-powerful-pair.py", {"n": 8, "m": 9}, "fail"),
    ("powerful-pair: (100, 101) has a square member", "spec-powerful-pair.py", {"n": 100, "m": 101}, "fail"),
    ("powerful-pair: non-consecutive (12167, 12169)", "spec-powerful-pair.py", {"n": 12167, "m": 12169}, "fail"),
    ("powerful-pair: missing m", "spec-powerful-pair.py", {"n": 12167}, "invalid"),
    ("powerful-pair: empty object", "spec-powerful-pair.py", {}, "invalid"),

    ("lpf-triplet: (13, 14, 15) with certificates", "spec-lpf-triplet.py",
     {"n": 13, "factors": {"n": [[13, 1]], "n1": [[2, 1], [7, 1]], "n2": [[3, 1], [5, 1]]}}, "pass"),
    ("lpf-triplet: wrong certificate product", "spec-lpf-triplet.py",
     {"n": 13, "factors": {"n": [[13, 1]], "n1": [[2, 2], [7, 1]], "n2": [[3, 1], [5, 1]]}}, "fail"),
    ("lpf-triplet: non-prime claimed factor", "spec-lpf-triplet.py",
     {"n": 13, "factors": {"n": [[13, 1]], "n1": [[2, 1], [7, 1]], "n2": [[15, 1]]}}, "fail"),

    ("lean-build: missing repo/target", "spec-lean-build.sh", {}, "invalid"),
    ("lean-build: not a lake project root", "spec-lean-build.sh", {"repo": "/tmp", "target": "Main.lean"}, "invalid"),

    ("witness-extraction: recorded pair + provenance", "spec-witness-extraction.py", WITNESS_EXTRACTION_OK, "pass"),
    ("witness-extraction: quote does not contain m", "spec-witness-extraction.py",
     {**WITNESS_EXTRACTION_OK, "provenance": {**WITNESS_EXTRACTION_OK["provenance"], "quotedText": "12167 = 23^3 is powerful."}}, "fail"),
    ("witness-extraction: weak exponent in certificate", "spec-witness-extraction.py",
     {**WITNESS_EXTRACTION_OK, "factorization": {"n": [[23, 1]], "m": [[2, 3], [3, 2], [13, 2]]}}, "fail"),
    ("witness-extraction: empty object", "spec-witness-extraction.py", {}, "invalid"),

    ("semantic-review: aligned report", "spec-semantic-review.py", SEMANTIC_REVIEW_ALIGNED, "pass"),
    ("semantic-review: evidenced divergent report", "spec-semantic-review.py", SEMANTIC_REVIEW_DIVERGENT, "pass"),
    ("semantic-review: divergent without evidence", "spec-semantic-review.py", SEMANTIC_REVIEW_NO_EVIDENCE, "fail"),
    ("semantic-review: missing definitions item", "spec-semantic-review.py", SEMANTIC_REVIEW_MISSING_ITEM, "fail"),
    ("semantic-review: unresolved artifact placeholder", "spec-semantic-review.py", SEMANTIC_REVIEW_PLACEHOLDER, "fail"),
    ("semantic-review: empty object", "spec-semantic-review.py", {}, "invalid"),
]

# Extra assertions on the pass payloads (mechanical reconciliation of the
# enumeration_closure self-check counts the specs publish).
EXTRA_ASSERTIONS = [
    ("witness-extraction: prime support count == 4", "spec-witness-extraction.py", WITNESS_EXTRACTION_OK,
     lambda payload: payload.get("expected_count") == 4),
    ("semantic-review: covered items == 3", "spec-semantic-review.py", SEMANTIC_REVIEW_ALIGNED,
     lambda payload: payload.get("expected_count") == 3),
    ("powerful-pair: union prime support count == 4 (closure self-check vector)", "spec-powerful-pair.py",
     {"n": 12167, "m": 12168},
     lambda payload: len({
         prime for side in ("n", "m") for prime in payload.get("factorization", {}).get(side, {})
     }) == 4),
]


def run_case(script, payload):
    path = os.path.join(HERE, script)
    interpreter = ["bash", path] if script.endswith(".sh") else [sys.executable, path]
    proc = subprocess.run(
        interpreter,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=120,
    )
    out = (proc.stdout or "").strip().splitlines()
    last = out[-1] if out else ""
    try:
        parsed = json.loads(last)
    except Exception:
        parsed = None
    return parsed, (proc.stdout or "") + (proc.stderr or "")


def main():
    failures = []
    for name, script, payload, expected in CASES:
        parsed, raw = run_case(script, payload)
        verdict = parsed.get("verdict") if isinstance(parsed, dict) else "<unparsable>"
        ok = verdict == expected
        print("%-4s %-58s expected=%-7s got=%s" % ("OK" if ok else "FAIL", name, expected, verdict))
        if not ok:
            failures.append("%s (expected %s, got %s)\n    raw: %s" % (name, expected, verdict, raw.strip()[:400]))

    for name, script, payload, assertion in EXTRA_ASSERTIONS:
        parsed, raw = run_case(script, payload)
        ok = isinstance(parsed, dict) and assertion(parsed)
        print("%-4s %-58s (extra assertion)" % ("OK" if ok else "FAIL", name))
        if not ok:
            failures.append("%s (assertion failed)\n    raw: %s" % (name, raw.strip()[:400]))

    total = len(CASES) + len(EXTRA_ASSERTIONS)
    if failures:
        print("\n%d/%d cases failed:" % (len(failures), total))
        for failure in failures:
            print("  - %s" % failure)
        return 1
    print("\nall %d verifier self-test cases passed" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
