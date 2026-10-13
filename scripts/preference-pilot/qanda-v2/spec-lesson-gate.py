#!/usr/bin/env python3
"""
spec-lesson-gate.py — Q&A UI v2 pilot, node LESSON structural gate (rubric item 1).

Preference-loop pilot spec script (MetaTask v1.3 §4.3 CI-style verifier).
Artifact contract: METATASK_ARTIFACT_URI is pin://<pinId> of a live
/protocols/preference/lesson pin (docs/metaid_protocols/09-preference.md §6)
whose round is a live /protocols/preference/round pin published by this
task's root author with subject {taskid: METATASK_TASKID, node: "UI"}. The
lesson's exemplars name round candidates, and every principle cites at
least 2 distinct reveal pins of that round.

This is a STRUCTURAL pre-check over public pins. The authoritative tally
(canonical round, winner, tallyHash, lesson validity) is rubric item 2:
the reviewer calls preference_round_status and quotes the result in
semantic_check. The script prints that step on the pass path.

Environment: METATASK_ARTIFACT_URI / METATASK_NODE / METATASK_TASKID.
Reads public HTTPS only (manapi.metaid.io).

Exit codes: 0 pass · 1 fail · 2 invalid / cannot judge. The check counter
is asserted against EXPECTED_CHECKS on the pass path (enumeration closure).
Test hook: PREFERENCE_GATE_FIXTURES=<fixtures.json> answers every HTTPS
read from local fixtures (selftest-gates.py only; verifiers never set it).
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

EXPECTED_CHECKS = 9
BUILD_NODE = "UI"
MIN_EVIDENCE_PER_PRINCIPLE = 2
MANAPI = "https://manapi.metaid.io"
PIN_ID_RE = re.compile(r"^[0-9a-f]{64}i[0-9]+$")
PIN_URI_RE = re.compile(r"^pin://([0-9a-f]{64}i[0-9]+)$")
TAG_RE = re.compile(r"^[a-z0-9-]+(:[a-z0-9-]+)?$")
CANDIDATE_ID_RE = re.compile(r"^[a-z0-9]{1,8}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")

checks_done = 0
fixtures = None


def note(line):
    print(line, flush=True)


def emit(verdict, detail, extra=None):
    record = {"verdict": verdict, "detail": detail, "checks": checks_done}
    record.update(extra or {})
    print(json.dumps(record, ensure_ascii=False), flush=True)


def invalid(detail):
    emit("invalid", detail)
    sys.exit(2)


def fail(detail):
    emit("fail", detail)
    print("FAIL: %s" % detail, file=sys.stderr)
    sys.exit(1)


def check(name, ok, detail=""):
    global checks_done
    checks_done += 1
    note("[check %d] %s: %s%s" % (checks_done, name, "ok" if ok else "FAIL", (" — " + detail) if detail else ""))
    if not ok:
        fail("%s%s" % (name, (" — " + detail) if detail else ""))


def gate(name, ok, detail=""):
    global checks_done
    checks_done += 1
    note("[check %d] %s: %s%s" % (checks_done, name, "ok" if ok else "INVALID", (" — " + detail) if detail else ""))
    if not ok:
        invalid("%s%s" % (name, (" — " + detail) if detail else ""))


def load_fixtures():
    global fixtures
    path = os.environ.get("PREFERENCE_GATE_FIXTURES", "").strip()
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            fixtures = json.load(handle)


def tls_context():
    """Verified TLS that also works on Python builds shipped without a CA bundle."""
    context = ssl.create_default_context()
    try:
        import certifi
        context.load_verify_locations(certifi.where())
        return context
    except Exception:
        pass
    for path in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"):
        if os.path.isfile(path):
            try:
                context.load_verify_locations(path)
                break
            except Exception:
                continue
    return context


TLS = tls_context()


def fetch(url, max_bytes=1 << 20):
    """Return (status, body); status None on a transport failure. Retries once."""
    if fixtures is not None:
        entry = fixtures.get("urls", {}).get(url)
        if entry is None:
            return None, b""
        if entry.get("status", 200) != 200:
            return entry["status"], b""
        if "json" in entry:
            return 200, json.dumps(entry["json"], ensure_ascii=False).encode("utf-8")[:max_bytes]
        return 200, entry.get("text", "").encode("utf-8")[:max_bytes]
    status = None
    for attempt in range(2):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "preference-pilot-gate/1.0"})
            with urllib.request.urlopen(request, timeout=60, context=TLS) as response:
                body = response.read(max_bytes)
                if body:
                    return response.status, body
                status = response.status
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return 404, b""
            status = err.code
        except Exception as err:
            note("[fetch] %s attempt %d failed: %s" % (url, attempt + 1, err))
            status = None
        time.sleep(1)
    return status, b""


def parse_json(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def to_int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def read_meta(pin_id):
    status, raw = fetch("%s/pin/%s" % (MANAPI, pin_id))
    envelope = parse_json(raw) if status == 200 else None
    meta = envelope.get("data") if isinstance(envelope, dict) and envelope.get("code") == 1 else None
    return meta if isinstance(meta, dict) else None


def read_pin(pin_id):
    """Return (meta, body) — meta None when unresolvable; body None when the content read failed."""
    meta = read_meta(pin_id)
    if meta is None:
        return None, None
    status, raw = fetch("%s/content/%s" % (MANAPI, pin_id))
    if status != 200:
        return meta, None
    return meta, parse_json(raw)


def pin_path(meta):
    return meta.get("path") or meta.get("originalPath")


def is_live(meta, path):
    return pin_path(meta) == path and to_int(meta.get("status")) == 0


def text_in(value, low, high):
    return isinstance(value, str) and low <= len(value.strip()) <= high


def lesson_problems(lesson):
    if not isinstance(lesson, dict):
        return ["body is not a JSON object"]
    problems = []
    if not (isinstance(lesson.get("round"), str) and PIN_ID_RE.match(lesson["round"])):
        problems.append("round is not a pinId")
    category = lesson.get("category")
    if not (isinstance(category, list) and 1 <= len(category) <= 8
            and all(isinstance(tag, str) and TAG_RE.match(tag) for tag in category)):
        problems.append("category must be 1..8 tags matching %s" % TAG_RE.pattern)
    if not text_in(lesson.get("summary"), 1, 1200):
        problems.append("summary must be 1..1200 chars")
    principles = lesson.get("principles")
    if not (isinstance(principles, list) and 1 <= len(principles) <= 12):
        problems.append("principles must be a 1..12 array")
        principles = []
    for index, principle in enumerate(principles, 1):
        if not isinstance(principle, dict):
            problems.append("principle %d is not an object" % index)
            continue
        if not text_in(principle.get("text"), 10, 400):
            problems.append("principle %d text must be 10..400 chars" % index)
        if not text_in(principle.get("conditions"), 1, 300):
            problems.append("principle %d conditions must be 1..300 chars" % index)
        if "uncertainty" in principle and not text_in(principle.get("uncertainty"), 0, 300):
            problems.append("principle %d uncertainty must be 0..300 chars" % index)
        evidence = principle.get("evidence")
        if not (isinstance(evidence, list) and 1 <= len(evidence) <= 20
                and all(isinstance(pin, str) and PIN_ID_RE.match(pin) for pin in evidence)
                and len(set(evidence)) == len(evidence)):
            problems.append("principle %d evidence must be 1..20 unique pinIds" % index)
    exemplars = lesson.get("exemplars")
    if not isinstance(exemplars, dict):
        problems.append("exemplars missing")
    else:
        preferred = exemplars.get("preferred")
        rejected = exemplars.get("rejected", [])
        if not (isinstance(preferred, str) and CANDIDATE_ID_RE.match(preferred)):
            problems.append("exemplars.preferred is not a candidate id")
        if not (isinstance(rejected, list) and all(isinstance(item, str) and CANDIDATE_ID_RE.match(item) for item in rejected)
                and len(set(rejected)) == len(rejected) and preferred not in rejected):
            problems.append("exemplars.rejected must be unique candidate ids other than preferred")
    if not (isinstance(lesson.get("tallyHash"), str) and HEX64_RE.match(lesson["tallyHash"])):
        problems.append("tallyHash is not 64 lowercase hex")
    return problems


def main():
    load_fixtures()
    uri = os.environ.get("METATASK_ARTIFACT_URI", "").strip()
    task_id = os.environ.get("METATASK_TASKID", "").strip()
    note("[env] METATASK_NODE=%s METATASK_TASKID=%s" % (os.environ.get("METATASK_NODE", ""), task_id))
    gate("artifact present", bool(uri), "" if uri else "METATASK_ARTIFACT_URI is empty")
    gate("METATASK_TASKID is a pinId", PIN_ID_RE.match(task_id) is not None, "got %r" % task_id)
    match = PIN_URI_RE.match(uri)
    check("artifact is pin://<pinId>", match is not None, "got %r" % uri)
    lesson_pin = match.group(1)

    lesson_meta, lesson = read_pin(lesson_pin)
    gate("lesson pin resolvable on manapi", lesson_meta is not None and lesson is not None, "pin %s" % lesson_pin)
    problems = lesson_problems(lesson)
    check("live /protocols/preference/lesson pin with a §6-shaped body",
          is_live(lesson_meta, "/protocols/preference/lesson") and not problems,
          "path=%r status=%r %s" % (pin_path(lesson_meta), lesson_meta.get("status"), "; ".join(problems)))

    round_pin = lesson["round"]
    round_meta, round_body = read_pin(round_pin)
    task_meta = read_meta(task_id)
    gate("round pin and task root pin resolvable on manapi",
         round_meta is not None and isinstance(round_body, dict) and task_meta is not None,
         "round %s task %s" % (round_pin, task_id))
    subject = round_body.get("subject")
    round_author = round_meta.get("globalMetaId")
    task_author = task_meta.get("globalMetaId")
    check("round is a live /protocols/preference/round pin by the task root author with subject {taskid: this task, node: %s}" % BUILD_NODE,
          is_live(round_meta, "/protocols/preference/round")
          and subject == {"taskid": task_id, "node": BUILD_NODE}
          and bool(round_author) and round_author == task_author,
          "path=%r status=%r subject=%r roundAuthor=%r taskAuthor=%r"
          % (pin_path(round_meta), round_meta.get("status"), subject, round_author, task_author))

    candidate_ids = [entry.get("id") for entry in round_body.get("candidates") or [] if isinstance(entry, dict)]
    preferred = lesson["exemplars"]["preferred"]
    rejected = lesson["exemplars"].get("rejected", [])
    thin = [index for index, principle in enumerate(lesson["principles"], 1)
            if len(set(principle["evidence"])) < MIN_EVIDENCE_PER_PRINCIPLE]
    check("exemplars name round candidates and every principle cites >= %d reveals" % MIN_EVIDENCE_PER_PRINCIPLE,
          preferred in candidate_ids and all(item in candidate_ids for item in rejected) and not thin,
          "candidates=%s preferred=%r rejected=%s thinPrinciples=%s" % (candidate_ids, preferred, rejected, thin))

    cited = sorted(set(pin for principle in lesson["principles"] for pin in principle["evidence"]))
    wrong = []
    for pin in cited:
        meta, body = read_pin(pin)
        if meta is None or body is None:
            invalid("evidence pin %s unresolvable on manapi" % pin)
        if not (is_live(meta, "/protocols/preference/reveal") and isinstance(body, dict) and body.get("round") == round_pin):
            wrong.append(pin)
    check("every cited evidence pin is a live reveal of this round", not wrong, "not reveals of %s: %s" % (round_pin, wrong[:5]))

    if checks_done != EXPECTED_CHECKS:
        fail("enumeration closure: ran %d checks, expected %d" % (checks_done, EXPECTED_CHECKS))
    note("[reviewer step — rubric item 2, tool-checked] call preference_round_status with "
         "subject {rootPinId: %s, node: %s}, lessonPinId %s, refresh true. Require canonical \"decided\", "
         "roundPinId %s, lesson.valid true, tallyHash %s, winner %s, and winnerRef equal to this submission's "
         "parentrefs.%s. Quote tallyHash and winner in semantic_check."
         % (task_id, BUILD_NODE, lesson_pin, round_pin, lesson["tallyHash"], preferred, BUILD_NODE))
    emit("pass", "LESSON structural gate holds", {
        "lesson": lesson_pin, "round": round_pin, "tallyHash": lesson["tallyHash"], "preferred": preferred,
    })
    sys.exit(0)


if __name__ == "__main__":
    main()
