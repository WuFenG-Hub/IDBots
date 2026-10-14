#!/usr/bin/env python3
"""
selftest-gates.py — offline self-test for the Q&A UI v2 pilot kit.

  * spec-ui-gate.py: static cases always run against local fixtures
    (PREFERENCE_GATE_FIXTURES); render cases run tiny hash-routed fixture
    apps in headless Chromium and need Playwright for Python. Without it
    they are SKIPPED, unless --require-render turns the skip into a failure.
  * spec-lesson-gate.py: every structural rule, fully offline.
  * Kit consistency: task-drafts.json is in sync with the template and the
    standalone scripts (embed-specs.py --check); validate-task-draft.py
    reports TASK DRAFT READY with exactly the expected WARNs (UI weight, plus
    the pack placeholder until it is backfilled); the builder
    pack's Appendix A is a verbatim copy of the Q&A frontend guide;
    round-open.json fits preference_round_open and design §6.2/§6.3.

Usage: python3 scripts/preference-pilot/qanda-v2/selftest-gates.py [--require-render]
Exit 0 prints SELFTEST GREEN; exit 1 lists every broken expectation.
"""
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
UI_GATE = os.path.join(HERE, "spec-ui-gate.py")
LESSON_GATE = os.path.join(HERE, "spec-lesson-gate.py")
EMBED = os.path.join(HERE, "embed-specs.py")
DRAFTS = os.path.join(HERE, "task-drafts.json")
VALIDATOR = os.path.join(REPO, "scripts", "metatask-wizard", "validate-task-draft.py")
PACK = os.path.join(HERE, "builder-pack.md")
GUIDE = os.path.join(REPO, "docs", "metaweb-qa-frontend-metaapp-guide.md")
APPENDIX_MARKER = "<!-- APPENDIX A: verbatim copy of docs/metaweb-qa-frontend-metaapp-guide.md -->\n"
PACK_PLACEHOLDER = "ARTIFACT_PIN:qanda-v2-pack"
ROUND_OPEN = os.path.join(HERE, "round-open.json")
ROUND_OPEN_KEYS = {"title", "brief", "category", "subject", "judges", "decisionKinds", "minBallots",
                   "dimensions", "tasks", "commitHours", "revealHours"}
TAG_RE = re.compile(r"^[a-z0-9-]+(:[a-z0-9-]+)?$")
DIMENSION_RE = re.compile(r"^[a-z][a-z0-9_]{0,23}$")

MANAPI = "https://manapi.metaid.io"
ZIP_URL = "https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/%s"
TASK = "a" * 64 + "i0"
APP = "b" * 64 + "i0"
ZIP_PIN = "c" * 64 + "i0"
ROUND = "d" * 64 + "i0"
LESSON = "e" * 64 + "i0"
REVEALS = ["%02x" % n * 32 + "i0" for n in range(1, 5)]
OTHER_ROUND = "f" * 64 + "i0"
TWIN = "idq1twin00000000000000000000000000"
STRANGER = "idq1stranger000000000000000000000"

failures = []
skipped = []


def expect(label, script, env_extra, fixtures, code, needles, workdir):
    path = os.path.join(workdir, "fixtures-%s.json" % label)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(fixtures, handle)
    env = dict(os.environ)
    for key in ("METATASK_ARTIFACT_URI", "METATASK_NODE", "METATASK_TASKID"):
        env.pop(key, None)
    env.update(env_extra)
    env["PREFERENCE_GATE_FIXTURES"] = path
    result = subprocess.run([sys.executable, script], env=env, capture_output=True, text=True, timeout=300)
    output = result.stdout + result.stderr
    missing = [needle for needle in needles if needle not in output]
    if result.returncode != code or missing:
        failures.append("%s: exit %d (want %d), missing %s\n%s" % (label, result.returncode, code, missing, output[-1500:]))
    else:
        print("ok   %s (exit %d)" % (label, code))


def meta(path, author=TWIN, status=0):
    return {"json": {"code": 1, "data": {"path": path, "status": str(status), "globalMetaId": author}}}


# ---- UI gate fixtures ------------------------------------------------------

APP_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>fixture</title><style>body{margin:0;font:16px sans-serif}main{padding:16px;overflow-wrap:anywhere}</style></head>
<body><main id="main" aria-busy="true"></main>
<script>
(function () {
  var main = document.getElementById('main');
  function render() {
    var hash = location.hash || '#/';
    var route = 'home';
    var extra = '';
    if (hash.indexOf('#/unanswered') === 0) route = 'unanswered';
    else if (hash.indexOf('#/q/') === 0) { route = 'question'; extra = hash.slice(4); }
    else if (hash.indexOf('#/u/') === 0) { route = 'author'; extra = hash.slice(4); }
    else if (hash.indexOf('#/search') === 0) route = 'search';
    main.setAttribute('aria-busy', 'true');
    main.setAttribute('data-route', route);
    setTimeout(function () {
      main.textContent = 'Fixture ' + route + ' page with enough text to pass the gate. ' + extra;
      main.setAttribute('aria-busy', 'false');
      /*VARIANT*/
    }, 50);
  }
  window.addEventListener('hashchange', render);
  render();
})();
</script></body></html>
"""
VARIANTS = {
    "good": "",
    "overflow": "main.insertAdjacentHTML('beforeend', '<div style=\"width:600px;height:10px\"></div>');",
    "pageerror": "setTimeout(function () { throw new Error('fixture boom'); }, 0);",
    "foreign": "var img = new Image(); img.src = 'https://example.com/pixel.png'; main.appendChild(img);",
    "busy": "main.setAttribute('aria-busy', 'true');",
    "noroute": "main.removeAttribute('data-route');",
}


def write_zip(path, members):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)


def ui_fixtures(workdir, zip_file, manifest=None, pin_meta=None, no_playwright=False):
    body = manifest if manifest is not None else {
        "title": "Fixture Q&A", "appName": "fixture-qa", "runtime": "browser", "version": "v1.0.0",
        "contentType": "application/zip", "content": "metafile://%s.zip" % ZIP_PIN, "indexFile": "index.html",
    }
    urls = {
        "%s/pin/%s" % (MANAPI, APP): pin_meta or meta("/protocols/metaapp"),
        "%s/content/%s" % (MANAPI, APP): {"json": body},
    }
    if zip_file:
        urls[ZIP_URL % ZIP_PIN] = {"file": os.path.relpath(zip_file, workdir)}
    return {"urls": urls, "noPlaywright": no_playwright}


def ui_cases(workdir, require_render):
    env = {"METATASK_ARTIFACT_URI": "metaapp://%s" % APP, "METATASK_NODE": "UI", "METATASK_TASKID": TASK}
    good_zip = os.path.join(workdir, "good.zip")
    write_zip(good_zip, {"index.html": APP_HTML.replace("/*VARIANT*/", VARIANTS["good"])})
    nested_zip = os.path.join(workdir, "nested.zip")
    write_zip(nested_zip, {"dist/index.html": APP_HTML, "dist/app.css": "main{}", "__MACOSX/dist/._index.html": "x"})
    missing_zip = os.path.join(workdir, "missing.zip")
    write_zip(missing_zip, {"main.html": APP_HTML})
    unsafe_zip = os.path.join(workdir, "unsafe.zip")
    write_zip(unsafe_zip, {"index.html": APP_HTML, "../evil.js": "alert(1)"})
    corrupt_zip = os.path.join(workdir, "corrupt.zip")
    with open(corrupt_zip, "wb") as handle:
        handle.write(b"PK\x03\x04" + b"\x00" * 64)
    big_zip = os.path.join(workdir, "big.zip")
    rng = random.Random(7)
    with zipfile.ZipFile(big_zip, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("index.html", APP_HTML)
        zf.writestr("blob.bin", rng.randbytes(5 * 1024 * 1024 + 1024))

    expect("ui-empty-uri", UI_GATE, dict(env, METATASK_ARTIFACT_URI=""), ui_fixtures(workdir, good_zip), 2,
           ["METATASK_ARTIFACT_URI is empty"], workdir)
    expect("ui-wrong-scheme", UI_GATE, dict(env, METATASK_ARTIFACT_URI="pin://%s" % APP), ui_fixtures(workdir, good_zip), 1,
           ["artifact is metaapp://<pinId>: FAIL"], workdir)
    expect("ui-unresolvable", UI_GATE, env, {"urls": {}}, 2, ["MetaApp pin resolvable on manapi: INVALID"], workdir)
    expect("ui-wrong-path", UI_GATE, env, ui_fixtures(workdir, good_zip, pin_meta=meta("/protocols/simplequestion")), 1,
           ["live /protocols/metaapp pin: FAIL"], workdir)
    expect("ui-revoked", UI_GATE, env, ui_fixtures(workdir, good_zip, pin_meta=meta("/protocols/metaapp", status=-1)), 1,
           ["live /protocols/metaapp pin: FAIL"], workdir)
    expect("ui-node-runtime", UI_GATE, env,
           ui_fixtures(workdir, good_zip, manifest={"runtime": "node", "content": "metafile://%s" % ZIP_PIN}), 1,
           ["manifest declares runtime browser"], workdir)
    expect("ui-zip-missing", UI_GATE, env, ui_fixtures(workdir, None), 2, ["ZIP downloadable from file.metaid.io: INVALID"], workdir)
    expect("ui-zip-corrupt", UI_GATE, env, ui_fixtures(workdir, corrupt_zip), 1, ["ZIP intact"], workdir)
    expect("ui-zip-too-big", UI_GATE, env, ui_fixtures(workdir, big_zip), 1, ["over the cap"], workdir)
    expect("ui-no-index", UI_GATE, env, ui_fixtures(workdir, missing_zip), 1, ["the indexFile exists: FAIL"], workdir)
    expect("ui-unsafe-path", UI_GATE, env, ui_fixtures(workdir, unsafe_zip), 1, ["the indexFile exists: FAIL", "../evil.js"], workdir)
    expect("ui-no-playwright", UI_GATE, env, ui_fixtures(workdir, good_zip, no_playwright=True), 2,
           ["render environment (Playwright for Python + Chromium): INVALID", "do NOT cast a verdict"], workdir)
    expect("ui-nested-root", UI_GATE, env, ui_fixtures(workdir, nested_zip, no_playwright=True), 2,
           ["the indexFile exists: ok", "render environment"], workdir)

    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            playwright.chromium.launch().close()
    except Exception as err:
        reason = "render cases need Playwright for Python + Chromium (%s)" % str(err).splitlines()[0]
        if require_render:
            failures.append(reason)
        else:
            skipped.append(reason)
        return
    for variant, code, needles in (
        ("good", 0, ['"verdict": "pass"', '"checks": 26']),
        ("overflow", 1, ["no horizontal overflow at 390 px: home: FAIL"]),
        ("pageerror", 1, ["no uncaught page errors: FAIL", "fixture boom"]),
        ("foreign", 1, ["network stays on the allowlist", "https://example.com/pixel.png"]),
        ("busy", 1, ["render home @1280x800", '"busy": "true"']),
        ("noroute", 1, ["render home @1280x800", '"route": null']),
    ):
        zip_file = os.path.join(workdir, "render-%s.zip" % variant)
        write_zip(zip_file, {"index.html": APP_HTML.replace("/*VARIANT*/", VARIANTS[variant])})
        expect("ui-render-%s" % variant, UI_GATE, env, ui_fixtures(workdir, zip_file), code, needles, workdir)


# ---- LESSON gate fixtures --------------------------------------------------

def lesson_body(**over):
    body = {
        "round": ROUND,
        "category": ["ui:qa-community", "audience:human"],
        "summary": "Judges preferred dense feeds that lead with the top answer.",
        "principles": [
            {"text": "Lead every feed item with its top answer summary.", "conditions": "Browse-first readers at 1280 and 390 px.",
             "uncertainty": "One round.", "evidence": [REVEALS[0], REVEALS[1]]},
            {"text": "Keep pinIds verbatim and copyable on question pages.", "conditions": "Readers who paste pinIds to bots.",
             "evidence": [REVEALS[2], REVEALS[3]]},
        ],
        "exemplars": {"preferred": "c2", "rejected": ["c1", "c3"]},
        "tallyHash": "9" * 64,
    }
    body.update(over)
    return body


def round_body(**over):
    body = {
        "title": "Q&A community UI v2", "category": ["ui:qa-community", "audience:human"],
        "subject": {"taskid": TASK, "node": "UI"},
        "candidates": [{"id": "c%d" % n, "ref": "%d" % n * 64 + "i0", "artifact": "metaapp://x", "author": STRANGER} for n in (1, 2, 3)],
        "judges": [{"id": TWIN, "kind": "human"}], "decision": {"kinds": ["human"], "minBallots": 1},
        "commitCloseAt": 1, "revealCloseAt": 2,
    }
    body.update(over)
    return body


def lesson_fixtures(lesson=None, round_=None, round_author=TWIN, lesson_path="/protocols/preference/lesson", reveal_round=ROUND, drop=None):
    urls = {
        "%s/pin/%s" % (MANAPI, LESSON): meta(lesson_path, author=STRANGER),
        "%s/content/%s" % (MANAPI, LESSON): {"json": lesson if lesson is not None else lesson_body()},
        "%s/pin/%s" % (MANAPI, ROUND): meta("/protocols/preference/round", author=round_author),
        "%s/content/%s" % (MANAPI, ROUND): {"json": round_ if round_ is not None else round_body()},
        "%s/pin/%s" % (MANAPI, TASK): meta("/protocols/metatask", author=TWIN),
    }
    for index, pin in enumerate(REVEALS):
        urls["%s/pin/%s" % (MANAPI, pin)] = meta("/protocols/preference/reveal", author=STRANGER)
        urls["%s/content/%s" % (MANAPI, pin)] = {"json": {"round": reveal_round if index == 3 else ROUND, "commit": TASK, "salt": "0" * 64, "ballot": {"pairs": []}}}
    for url in drop or []:
        urls.pop(url, None)
    return {"urls": urls}


def lesson_cases(workdir):
    env = {"METATASK_ARTIFACT_URI": "pin://%s" % LESSON, "METATASK_NODE": "LESSON", "METATASK_TASKID": TASK}
    thin = lesson_body()
    thin["principles"][1]["evidence"] = [REVEALS[2]]
    short = lesson_body()
    short["principles"][0]["text"] = "Too short"
    expect("lesson-valid", LESSON_GATE, env, lesson_fixtures(), 0,
           ['"verdict": "pass"', '"checks": 9', "reviewer step", "tallyHash " + "9" * 64], workdir)
    expect("lesson-empty-uri", LESSON_GATE, dict(env, METATASK_ARTIFACT_URI=""), lesson_fixtures(), 2, ["METATASK_ARTIFACT_URI is empty"], workdir)
    expect("lesson-no-taskid", LESSON_GATE, dict(env, METATASK_TASKID=""), lesson_fixtures(), 2, ["METATASK_TASKID is a pinId: INVALID"], workdir)
    expect("lesson-wrong-scheme", LESSON_GATE, dict(env, METATASK_ARTIFACT_URI="metaapp://%s" % LESSON), lesson_fixtures(), 1,
           ["artifact is pin://<pinId>: FAIL"], workdir)
    expect("lesson-wrong-path", LESSON_GATE, env, lesson_fixtures(lesson_path="/protocols/simplebuzz"), 1, ["§6-shaped body: FAIL"], workdir)
    expect("lesson-short-principle", LESSON_GATE, env, lesson_fixtures(lesson=short), 1, ["principle 1 text must be 10..400 chars"], workdir)
    expect("lesson-subject-mismatch", LESSON_GATE, env, lesson_fixtures(round_=round_body(subject={"taskid": OTHER_ROUND, "node": "UI"})), 1,
           ["by the task root author", "FAIL"], workdir)
    expect("lesson-round-not-by-twin", LESSON_GATE, env, lesson_fixtures(round_author=STRANGER), 1, ["roundAuthor=%r" % STRANGER], workdir)
    expect("lesson-preferred-unknown", LESSON_GATE, env, lesson_fixtures(lesson=lesson_body(exemplars={"preferred": "c9", "rejected": []})), 1,
           ["exemplars name round candidates", "preferred='c9'"], workdir)
    expect("lesson-thin-principle", LESSON_GATE, env, lesson_fixtures(lesson=thin), 1, ["thinPrinciples=[2]"], workdir)
    expect("lesson-foreign-evidence", LESSON_GATE, env, lesson_fixtures(reveal_round=OTHER_ROUND), 1,
           ["live reveal of this round: FAIL", REVEALS[3]], workdir)
    expect("lesson-evidence-unresolvable", LESSON_GATE, env, lesson_fixtures(drop=["%s/pin/%s" % (MANAPI, REVEALS[0])]), 2,
           ["evidence pin %s unresolvable" % REVEALS[0]], workdir)


# ---- kit consistency -------------------------------------------------------

def kit_cases():
    embed = subprocess.run([sys.executable, EMBED, "--check"], capture_output=True, text=True)
    if embed.returncode != 0:
        failures.append("embed-specs.py --check: %s" % (embed.stdout + embed.stderr).strip())
    else:
        print("ok   task-drafts.json in sync")
    validate = subprocess.run([sys.executable, VALIDATOR, DRAFTS], capture_output=True, text=True)
    out = validate.stdout
    warns = [line for line in out.splitlines() if line.startswith("WARN ")]
    with open(DRAFTS, "r", encoding="utf-8") as handle:
        pending = PACK_PLACEHOLDER in handle.read()
    expected = ["node UI: weight"] + (["placeholders: ARTIFACT_PIN family"] if pending else [])
    if validate.returncode != 0 or "TASK DRAFT READY" not in out or len(warns) != len(expected) \
            or not all(any(needle in line for line in warns) for needle in expected):
        failures.append("validate-task-draft.py: exit %d, WARNs %s\n%s" % (validate.returncode, warns, out[-1500:]))
    else:
        print("ok   drafts READY with the expected WARNs (%s)" % ("pack placeholder pending" if pending else "pack backfilled"))
    with open(PACK, "r", encoding="utf-8") as handle:
        pack = handle.read()
    with open(GUIDE, "r", encoding="utf-8") as handle:
        guide = handle.read()
    if APPENDIX_MARKER not in pack or pack.split(APPENDIX_MARKER, 1)[1] != guide:
        failures.append("builder-pack.md: Appendix A is not a verbatim copy of %s" % os.path.relpath(GUIDE, REPO))
    else:
        print("ok   builder pack appendix is verbatim")
    for script in (UI_GATE, LESSON_GATE):
        with open(script, "r", encoding="utf-8") as handle:
            text = handle.read()
        if "METATASK_DOWNLOAD_BASE" in text:
            failures.append("%s must read public HTTPS directly (METATASK_DOWNLOAD_BASE is not provided to verifiers)" % os.path.basename(script))
    problems = round_open_problems()
    if problems:
        failures.append("round-open.json: %s" % "; ".join(problems))
    else:
        print("ok   round-open.json fits preference_round_open and the pilot plan")


def round_open_problems():
    with open(ROUND_OPEN, "r", encoding="utf-8") as handle:
        args = json.load(handle)
    problems = []
    unknown = sorted(set(args) - ROUND_OPEN_KEYS - {"_comment"})
    if unknown:
        problems.append("unknown keys %s" % unknown)
    if not (isinstance(args.get("title"), str) and 1 <= len(args["title"]) <= 200):
        problems.append("title must be 1..200 chars")
    if not (isinstance(args.get("brief"), str) and len(args["brief"]) <= 4000):
        problems.append("brief must be <= 4000 chars")
    category = args.get("category")
    if not (isinstance(category, list) and 1 <= len(category) <= 8 and all(TAG_RE.match(tag) for tag in category)):
        problems.append("category must be 1..8 tags")
    if args.get("subject", {}).get("node") != "UI" or "candidates" in args:
        problems.append("subject mode on node UI only (no explicit candidates)")
    judges = args.get("judges") or []
    humans = [judge for judge in judges if judge.get("kind") == "human"]
    if not (1 <= len(judges) <= 32 and all(judge.get("kind") in ("human", "ai") for judge in judges)):
        problems.append("judges must be 1..32 {globalMetaId, kind human|ai}")
    if args.get("decisionKinds") != ["human"] or args.get("minBallots") != 3 or len(humans) < 3:
        problems.append("design §6.3: humans decide, minBallots 3, at least 3 human judges")
    dimensions = args.get("dimensions") or []
    if not (len(dimensions) <= 6 and all(DIMENSION_RE.match(item.get("id", "")) and 1 <= len(item.get("label", "")) <= 48 for item in dimensions)):
        problems.append("dimensions must be <= 6 with ids matching %s and 1..48-char labels" % DIMENSION_RE.pattern)
    tasks = args.get("tasks") or []
    if not (len(tasks) <= 5 and all(1 <= len(task) <= 300 for task in tasks)):
        problems.append("tasks must be <= 5 entries of 1..300 chars")
    if args.get("commitHours") != 48 or args.get("revealHours") != 24:
        problems.append("design §6.2: commitHours 48, revealHours 24")
    return problems


def main():
    require_render = "--require-render" in sys.argv[1:]
    workdir = tempfile.mkdtemp(prefix="preference-selftest-")
    try:
        ui_cases(workdir, require_render)
        lesson_cases(workdir)
        kit_cases()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    for reason in skipped:
        print("SKIP %s" % reason)
    if failures:
        print("\nSELFTEST RED — %d failure(s):" % len(failures))
        for message in failures:
            print("  - %s" % message)
        return 1
    print("\nSELFTEST GREEN%s" % (" (render cases skipped)" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
