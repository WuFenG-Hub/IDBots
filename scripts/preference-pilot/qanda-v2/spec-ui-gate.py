#!/usr/bin/env python3
"""
spec-ui-gate.py — Q&A UI v2 pilot, node UI hard gate (rubric items 1-4).

Preference-loop pilot spec script (MetaTask v1.3 §4.3 CI-style verifier).
Machine checks only: rubric items 5-8 are reviewer judgment, and which
build humans prefer is decided by the preference round
(docs/metaid_protocols/09-preference.md §7), never by this script.

Artifact contract (builder pack §1): METATASK_ARTIFACT_URI is
metaapp://<pinId> of a live /protocols/metaapp pin whose manifest declares
runtime browser, contentType application/zip, and content
metafile://<pinId> of a ZIP (<= 5 MB, relative paths only) that contains
the declared indexFile. The app implements the route and markup contract:

  #/                       <main data-route="home">
  #/unanswered             <main data-route="unanswered">
  #/q/<question pinId>     <main data-route="question">  shows the pinId verbatim
  #/u/<globalMetaId>       <main data-route="author">    shows the globalMetaId verbatim
  #/search?q=<term>        <main data-route="search">

Exactly one <main>; aria-busy="true" on it while the route's primary data
loads. Each route must settle within 8 s at 1280x800 and 390x844 with at
least 40 characters of text in <main>; no horizontal overflow at 390 px;
no uncaught page errors; every request (first hop of each redirect chain)
goes to so.metaid.io, file.metaid.io, or the app's own origin.

Environment: METATASK_ARTIFACT_URI / METATASK_NODE / METATASK_TASKID.
Reads public HTTPS only (manapi.metaid.io, file.metaid.io). The render
phase needs Playwright for Python with Chromium:
  python3 -m pip install playwright && python3 -m playwright install chromium
Without it the script exits 2 (cannot judge): never cast a verdict from
such a run.

Exit codes: 0 pass · 1 fail · 2 invalid / cannot judge. The check counter
is asserted against EXPECTED_CHECKS on the pass path (enumeration closure).
Test hook: PREFERENCE_GATE_FIXTURES=<fixtures.json> answers every HTTPS
read from local fixtures (selftest-gates.py only; verifiers never set it).
"""
import functools
import hashlib
import http.server
import io
import json
import os
import re
import shutil
import ssl
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

EXPECTED_CHECKS = 26
SAMPLE_QUESTION = "266c3b1c4315e09d10a0440009abb2cc9abf6738aec6816928a96f425062a2fai0"
SAMPLE_AUTHOR = "idq1km9w58d3n0u7mec27lhepyjlmrnwrzctmu3wrh"
SEARCH_TERM = "protocol"
ROUTES = (
    ("home", "#/", None),
    ("unanswered", "#/unanswered", None),
    ("question", "#/q/" + SAMPLE_QUESTION, SAMPLE_QUESTION),
    ("author", "#/u/" + SAMPLE_AUTHOR, SAMPLE_AUTHOR),
    ("search", "#/search?q=" + SEARCH_TERM, None),
)
VIEWPORTS = ((1280, 800), (390, 844))
OVERFLOW_WIDTH = 390
RENDER_TIMEOUT_MS = 8000
MIN_MAIN_TEXT = 40
MAX_ZIP_BYTES = 5 * 1024 * 1024
ALLOWED_HOSTS = ("so.metaid.io", "file.metaid.io")
MANAPI = "https://manapi.metaid.io"
ZIP_URL_TEMPLATES = (
    "https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/%s",
    "https://file.metaid.io/metafile-indexer/api/v1/files/content/%s",
)
METAAPP_RE = re.compile(r"^metaapp://([0-9a-f]{64}i[0-9]+)$")
METAFILE_RE = re.compile(r"^metafile://([0-9a-f]{64}i[0-9]+)(?:\.[A-Za-z0-9]+)?$")
SETTLED_JS = """([route, marker, minText]) => {
  const mains = document.querySelectorAll('main');
  if (mains.length !== 1) return false;
  const main = mains[0];
  if (main.getAttribute('data-route') !== route) return false;
  if (main.getAttribute('aria-busy') === 'true') return false;
  const text = (main.innerText || '').trim();
  return text.length >= minText && (!marker || text.includes(marker));
}"""
DIAGNOSE_JS = """([marker]) => {
  const mains = document.querySelectorAll('main');
  const main = mains[0];
  const text = main ? (main.innerText || '').trim() : '';
  return {
    mains: mains.length,
    route: main ? main.getAttribute('data-route') : null,
    busy: main ? main.getAttribute('aria-busy') : null,
    textLength: text.length,
    markerShown: marker ? text.includes(marker) : null,
  };
}"""
OVERFLOW_JS = """() => ({
  scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
  innerWidth: window.innerWidth,
})"""

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
        fixtures["_dir"] = os.path.dirname(os.path.abspath(path))


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


def fetch(url, max_bytes):
    """Return (status, body); status None on a transport failure. Retries once."""
    if fixtures is not None:
        entry = fixtures.get("urls", {}).get(url)
        if entry is None:
            return None, b""
        if entry.get("status", 200) != 200:
            return entry["status"], b""
        if "json" in entry:
            return 200, json.dumps(entry["json"], ensure_ascii=False).encode("utf-8")[:max_bytes]
        if "file" in entry:
            with open(os.path.join(fixtures["_dir"], entry["file"]), "rb") as handle:
                return 200, handle.read(max_bytes)
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


def read_pin(pin_id):
    """Return (meta, body_bytes) from manapi, or (None, None) when unresolvable."""
    status, raw = fetch("%s/pin/%s" % (MANAPI, pin_id), 1 << 20)
    envelope = parse_json(raw) if status == 200 else None
    meta = envelope.get("data") if isinstance(envelope, dict) and envelope.get("code") == 1 else None
    if not isinstance(meta, dict):
        return None, None
    status, body = fetch("%s/content/%s" % (MANAPI, pin_id), 1 << 20)
    if status != 200:
        return meta, None
    return meta, body


def safe_names(zf):
    names = [name for name in zf.namelist() if not name.endswith("/") and not name.startswith("__MACOSX/")]
    unsafe = [name for name in names
              if name.startswith("/") or "\\" in name or re.match(r"^[A-Za-z]:", name)
              or any(part == ".." for part in name.split("/"))]
    return names, unsafe


def strip_single_root(names, index_file):
    if index_file in names:
        return ""
    tops = set(name.split("/")[0] for name in names)
    if len(tops) == 1 and all("/" in name for name in names):
        return list(tops)[0] + "/"
    return ""


def allowed_url(url, origin):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme in ("data", "blob", "about"):
        return True
    if "%s://%s" % (parsed.scheme, parsed.netloc) == origin:
        return True
    return parsed.scheme in ("https", "wss") and (parsed.hostname or "") in ALLOWED_HOSTS


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def render_phase(app_dir, index_file):
    try:
        if fixtures is not None and fixtures.get("noPlaywright"):
            raise ImportError("Playwright disabled by the test fixtures")
        from playwright.sync_api import sync_playwright
    except ImportError as err:
        gate("render environment (Playwright for Python + Chromium)", False,
             "%s — install: python3 -m pip install playwright && python3 -m playwright install chromium; "
             "do NOT cast a verdict from this run" % err)
        return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=app_dir))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:%d" % server.server_address[1]
    entry = "%s/%s" % (origin, urllib.parse.quote(index_file))
    page_errors = []
    foreign = []

    def guard(route, request):
        if allowed_url(request.url, origin):
            route.continue_()
        else:
            foreign.append(request.url)
            route.abort()

    try:
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch()
            except Exception as err:
                gate("render environment (Playwright for Python + Chromium)", False,
                     "Chromium failed to launch: %s — run: python3 -m playwright install chromium; "
                     "do NOT cast a verdict from this run" % str(err).splitlines()[0])
            gate("render environment (Playwright for Python + Chromium)", True)
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height}, service_workers="block")
                context.route("**/*", guard)
                for name, hash_route, marker in ROUTES:
                    page = context.new_page()
                    page.on("pageerror", lambda error, where="%s@%d" % (name, width): page_errors.append("%s: %s" % (where, error)))
                    page.on("websocket", lambda socket: None if allowed_url(socket.url, origin) else foreign.append(socket.url))
                    label = "%s @%dx%d" % (name, width, height)
                    try:
                        page.goto(entry + hash_route, wait_until="commit", timeout=RENDER_TIMEOUT_MS)
                        page.wait_for_function(SETTLED_JS, arg=[name, marker, MIN_MAIN_TEXT], timeout=RENDER_TIMEOUT_MS)
                        settled, why = True, ""
                    except Exception as err:
                        settled = False
                        try:
                            why = json.dumps(page.evaluate(DIAGNOSE_JS, [marker]))
                        except Exception:
                            why = str(err).splitlines()[0]
                    check("render %s settles within %d ms (data-route, not busy, >= %d chars%s)"
                          % (label, RENDER_TIMEOUT_MS, MIN_MAIN_TEXT, ", marker shown" if marker else ""), settled, why)
                    if width == OVERFLOW_WIDTH:
                        size = page.evaluate(OVERFLOW_JS)
                        check("no horizontal overflow at %d px: %s" % (OVERFLOW_WIDTH, name),
                              size["scrollWidth"] <= size["innerWidth"] + 1,
                              "scrollWidth %d vs innerWidth %d" % (size["scrollWidth"], size["innerWidth"]))
                    page.close()
                context.close()
            browser.close()
    finally:
        server.shutdown()
    check("no uncaught page errors", not page_errors, "; ".join(page_errors[:5]))
    check("network stays on the allowlist (%s + own origin)" % ", ".join(ALLOWED_HOSTS), not foreign,
          "; ".join(sorted(set(foreign))[:5]))


def main():
    load_fixtures()
    uri = os.environ.get("METATASK_ARTIFACT_URI", "").strip()
    note("[env] METATASK_NODE=%s METATASK_TASKID=%s" % (os.environ.get("METATASK_NODE", ""), os.environ.get("METATASK_TASKID", "")))
    gate("artifact present", bool(uri), "" if uri else "METATASK_ARTIFACT_URI is empty")
    match = METAAPP_RE.match(uri)
    check("artifact is metaapp://<pinId>", match is not None, "got %r" % uri)
    app_pin = match.group(1)

    meta, body = read_pin(app_pin)
    gate("MetaApp pin resolvable on manapi", meta is not None and body is not None, "pin %s" % app_pin)
    path = meta.get("path") or meta.get("originalPath")
    pin_status = to_int(meta.get("status"))
    check("pin is a live /protocols/metaapp pin", path == "/protocols/metaapp" and pin_status == 0,
          "path=%r status=%r" % (path, meta.get("status")))

    manifest = parse_json(body)
    manifest = manifest if isinstance(manifest, dict) else {}
    runtimes = [part.strip() for part in str(manifest.get("runtime") or "").split("/") if part.strip()]
    content_type = str(manifest.get("contentType") or "application/zip").strip()
    content = str(manifest.get("content") or manifest.get("code") or "").strip()
    zip_match = METAFILE_RE.match(content)
    index_file = re.sub(r"^(\./|/)+", "", str(manifest.get("indexFile") or "index.html").strip())
    check("manifest declares runtime browser, contentType application/zip, content metafile://<pinId>",
          "browser" in runtimes and content_type == "application/zip" and zip_match is not None and bool(index_file),
          "runtime=%r contentType=%r content=%r indexFile=%r"
          % (manifest.get("runtime"), content_type, content, manifest.get("indexFile")))

    blob = None
    for template in ZIP_URL_TEMPLATES:
        status, data = fetch(template % zip_match.group(1), MAX_ZIP_BYTES + 1)
        if status == 200 and data:
            blob = data
            if data[:4] == b"PK\x03\x04":
                break
    gate("ZIP downloadable from file.metaid.io", blob is not None, "metafile %s" % zip_match.group(1))
    zf = None
    try:
        if len(blob) <= MAX_ZIP_BYTES:
            zf = zipfile.ZipFile(io.BytesIO(blob))
            bad_member = zf.testzip()
            if bad_member is not None:
                zf = None
    except zipfile.BadZipFile:
        zf = None
    check("ZIP intact and <= %d bytes" % MAX_ZIP_BYTES, zf is not None,
          "%d bytes%s" % (len(blob), " (over the cap)" if len(blob) > MAX_ZIP_BYTES else ""))
    names, unsafe = safe_names(zf)
    prefix = strip_single_root(names, index_file)
    stripped = [name[len(prefix):] for name in names if name.startswith(prefix)]
    check("ZIP paths are relative and the indexFile exists", not unsafe and index_file in stripped,
          "unsafe=%s indexFile=%r" % (unsafe[:3], index_file))
    zip_sha256 = hashlib.sha256(blob).hexdigest()
    note("[evidence] app %s zip %s sha256 %s" % (app_pin, zip_match.group(1), zip_sha256))

    app_dir = tempfile.mkdtemp(prefix="preference-ui-gate-")
    try:
        for name in names:
            if not name.startswith(prefix):
                continue
            target = os.path.join(app_dir, *name[len(prefix):].split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(zf.read(name))
        render_phase(app_dir, index_file)
    finally:
        shutil.rmtree(app_dir, ignore_errors=True)

    if checks_done != EXPECTED_CHECKS:
        fail("enumeration closure: ran %d checks, expected %d" % (checks_done, EXPECTED_CHECKS))
    emit("pass", "UI gate rubric items 1-4 hold", {"app": app_pin, "zipSha256": zip_sha256})
    sys.exit(0)


if __name__ == "__main__":
    main()
