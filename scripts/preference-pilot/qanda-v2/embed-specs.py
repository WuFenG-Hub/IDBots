#!/usr/bin/env python3
"""
embed-specs.py — regenerate task-drafts.json from the hand-authored
task-drafts.template.json plus the standalone spec scripts.

The published drafts file carries every spec's script INLINE, byte-identical
to the standalone script named by the template's scriptFile staging key, so
reviewers and metatask_publish read one file. Workflow: edit the standalone
script or the template, re-run this generator, re-run selftest-gates.py.

Usage: python3 scripts/preference-pilot/qanda-v2/embed-specs.py [--check]
  --check   do not write; exit 1 when task-drafts.json is stale
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "task-drafts.template.json")
OUTPUT = os.path.join(HERE, "task-drafts.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    with open(TEMPLATE, "r", encoding="utf-8") as handle:
        drafts = json.load(handle)

    for key, spec in sorted(drafts["specs"].items()):
        script_file = spec.pop("scriptFile", None)
        if not script_file:
            print("spec %s: missing scriptFile staging key" % key)
            return 1
        with open(os.path.join(HERE, script_file), "r", encoding="utf-8") as handle:
            spec["script"] = handle.read()
        ordered = {"name": spec["name"], "lang": spec["lang"], "entry": spec["entry"], "script": spec["script"]}
        for field in ("input", "output", "validation", "workspace"):
            if field in spec:
                ordered[field] = spec[field]
        drafts["specs"][key] = ordered

    text = json.dumps(drafts, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        try:
            with open(OUTPUT, "r", encoding="utf-8") as handle:
                current = handle.read()
        except OSError:
            current = None
        if current != text:
            print("task-drafts.json is STALE — re-run embed-specs.py")
            return 1
        print("task-drafts.json is up to date")
        return 0
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(text)
    print("wrote %s (%d bytes)" % (OUTPUT, len(text.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
