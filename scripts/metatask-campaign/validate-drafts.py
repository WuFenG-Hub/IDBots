#!/usr/bin/env python3
"""
validate-drafts.py — pre-publish validator for the MetaTask wave-1 launch kit.

Usage:
  python3 scripts/metatask-campaign/validate-drafts.py [--drafts PATH] [--artifacts PATH] [--readme PATH]

It refuses to run the campaign (exit code 1) unless every publish invariant the
built-in `metatask_publish` tool and protocol v1.2.1 enforce holds in the drafts:

  * the drafts carry no staging keys the tool does not understand (scriptFile,
    snake_case policy keys, ...)
  * every task's publish payload is tool-shaped: title/brief, one root,
    unique node ids, resolvable acyclic parents, weights summing to exactly
    10000, policy keys camelCase and in range
  * every node's effective spec (its own specid override, else the task root
    spec) resolves to a spec present in the drafts
  * every spec has name/lang/entry, a non-empty non-placeholder script (inlined
    text, kept byte-identical to the standalone file of the same name), an
    input/output descriptor, and a complete protocol-mandatory validation block
    (null_tolerance + enumeration_closure with an integer self-check count +
    proposition_fidelity referencing an INDEPENDENT correspondence artifact
    pin — never a self-declared boolean)
  * every spec-pin placeholder is consistently marked: SPEC_PIN:<key> overrides
    only for specs with a standalone pre-pass pin plan, and
    PUBLISH_ARTIFACT_FIRST only while the referenced correspondence artifact is
    itself still marked unpublished
  * the correspondence artifact drafts resolve, cover the protocol's three
    fidelity items, and quote the bank record verbatim where they claim to
  * the runbook (README.md) names every wave-1 task and every HELD id, and
    documents the publish placeholder and the wave-1 no-amend policy
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DRAFTS = os.path.join(HERE, "wave1-task-drafts.json")
DEFAULT_ARTIFACTS = os.path.join(HERE, "wave1-correspondence-artifacts.json")
DEFAULT_README = os.path.join(HERE, "README.md")

TOOL_TASK_FIELDS = {"title", "brief", "nodes", "policy", "tags"}
TOOL_NODE_FIELDS = {"id", "parent", "title", "kind", "specid", "params", "deps", "weight"}
TOOL_SPEC_FIELDS = {"name", "lang", "entry", "script", "input", "output", "validation"}
TOOL_POLICY_FIELDS = {"claimTtlHours", "verifyQuorum", "verifyWindowHours", "rewardSat", "challengeTtlDays", "submitterShareBP"}
POLICY_REQUIRED = ("claimTtlHours", "verifyQuorum", "verifyWindowHours")
NODE_KINDS = {"triage", "search", "proof", "aggregate", "formalize"}
VALIDATION_ITEMS = ("null_tolerance", "enumeration_closure", "proposition_fidelity")
COVERAGE_ITEMS = ["statement", "definitions", "proof-direction"]
STAGING_KEYS = {
    "scriptFile", "script_file", "policyOverride", "claim_ttl_hours", "verify_window_hours",
    "verify_quorum", "reward_sat", "challenge_ttl_days", "submitterShareBP_", "specId",
}
SPEC_PIN_PREFIX = "SPEC_PIN:"
PLACEHOLDER = "PUBLISH_ARTIFACT_FIRST"
PLAN_STANDALONE = "PUBLISH_SPEC_FIRST"
PLAN_BY_PUBLISH = "PUBLISHED_BY_METATASK_PUBLISH"
PIN_REF_RE = re.compile(r"^(pin://|metafile://)\S+$")

errors = []
checks = []


def ok(name, detail=""):
    checks.append("OK   %s%s" % (name, (" — " + detail) if detail else ""))


def bad(name, detail):
    message = "%s: %s" % (name, detail)
    errors.append(message)
    checks.append("FAIL " + message)


def check(condition, name, detail=""):
    if condition:
        ok(name, detail)
    else:
        bad(name, detail)
    return bool(condition)


def walk_keys(node, path=""):
    """Yield (path, key, value) for every object key in the document."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield path, key, value
            yield from walk_keys(value, "%s.%s" % (path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_keys(value, "%s[%d]" % (path, index))


def find_int_counts(node, key="expected_count"):
    found = []
    if isinstance(node, dict):
        for k, value in node.items():
            if k == key and isinstance(value, int) and not isinstance(value, bool):
                found.append(value)
            found.extend(find_int_counts(value, key))
    elif isinstance(node, list):
        for value in node:
            found.extend(find_int_counts(value, key))
    return found


def find_bools(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from find_bools(value)
    elif isinstance(node, list):
        for value in node:
            yield from find_bools(value)
    elif isinstance(node, bool):
        yield node


def load_json(path, label):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as err:
        bad(label, "cannot load %s: %s" % (path, err))
        return None


def validate_policy(policy, where):
    if not isinstance(policy, dict):
        bad(where, "policy missing or not an object")
        return
    unknown = sorted(set(policy) - TOOL_POLICY_FIELDS)
    check(not unknown, "%s.policy: keys are tool-shaped camelCase" % where, "" if not unknown else "unknown keys %s" % unknown)
    for field in POLICY_REQUIRED:
        value = policy.get(field)
        if field == "verifyQuorum":
            check(isinstance(value, int) and not isinstance(value, bool) and value >= 1,
                  "%s.policy.%s: integer >= 1" % (where, field), "got %r" % (value,))
        else:
            check(isinstance(value, int) and not isinstance(value, bool) and value > 0,
                  "%s.policy.%s: positive integer" % (where, field), "got %r" % (value,))
    share = policy.get("submitterShareBP")
    if share is not None:
        check(isinstance(share, int) and 6000 <= share <= 9000,
              "%s.policy.submitterShareBP: integer in [6000, 9000]" % where, "got %r" % (share,))
    for field in ("rewardSat", "challengeTtlDays"):
        value = policy.get(field)
        if value is not None:
            check(isinstance(value, int) and not isinstance(value, bool) and value > 0,
                  "%s.policy.%s: positive integer" % (where, field), "got %r" % (value,))


def validate_tree(task_id, nodes, spec_keys, root_spec):
    where = "task %s" % task_id
    if not isinstance(nodes, list) or not nodes:
        bad(where, "nodes missing or empty")
        return
    ids = [node.get("id") for node in nodes if isinstance(node, dict)]
    check(all(isinstance(node_id, str) and node_id for node_id in ids) and len(set(ids)) == len(ids),
          "%s: node ids present and unique" % where, "ids %s" % ids)
    if len(set(ids)) != len(ids):
        return
    id_set = set(ids)
    unknown_fields = sorted({key for node in nodes for key in node} - TOOL_NODE_FIELDS)
    check(not unknown_fields, "%s: node keys are tool-shaped" % where, "" if not unknown_fields else "unknown keys %s" % unknown_fields)

    roots = [node for node in nodes if node.get("parent") is None]
    if not check(len(roots) == 1, "%s: exactly one root (parent=null)" % where, "found %d" % len(roots)):
        return
    for node in nodes:
        parent = node.get("parent")
        if parent is not None and parent not in id_set:
            bad("%s node %s" % (where, node.get("id")), "unknown parent %r" % (parent,))
        kind = node.get("kind")
        if kind not in NODE_KINDS:
            bad("%s node %s" % (where, node.get("id")), "kind %r not in %s" % (kind, sorted(NODE_KINDS)))
        title = node.get("title")
        if not isinstance(title, str) or not title.strip():
            bad("%s node %s" % (where, node.get("id")), "title missing or empty")
        weight = node.get("weight")
        if not isinstance(weight, int) or isinstance(weight, bool) or not 1 <= weight <= 10000:
            bad("%s node %s" % (where, node.get("id")), "weight must be an integer in [1, 10000], got %r" % (weight,))
        for dep in node.get("deps") or []:
            if dep not in id_set:
                bad("%s node %s" % (where, node.get("id")), "unknown dep %r" % (dep,))

    by_id = {node["id"]: node for node in nodes}
    cyclic = []
    for node in nodes:
        seen = set()
        cursor = node["id"]
        while cursor is not None:
            if cursor in seen:
                cyclic.append(node["id"])
                break
            seen.add(cursor)
            cursor = by_id.get(cursor, {}).get("parent")
    check(not cyclic, "%s: parent graph acyclic" % where, "" if not cyclic else "cycles at %s" % sorted(set(cyclic)))

    total = sum(node.get("weight") for node in nodes if isinstance(node.get("weight"), int))
    check(total == 10000, "%s: weights sum to exactly 10000" % where, "got %d" % total)

    for node in nodes:
        specid = node.get("specid")
        if specid is None:
            effective = root_spec
        elif isinstance(specid, str) and specid.startswith(SPEC_PIN_PREFIX):
            effective = specid[len(SPEC_PIN_PREFIX):]
            if specid[len(SPEC_PIN_PREFIX):] == root_spec:
                bad("%s node %s" % (where, node["id"]),
                    "specid override repeats the task root spec — use null to inherit it")
        else:
            bad("%s node %s" % (where, node["id"]),
                "specid must be null or %s<spec key>, got %r" % (SPEC_PIN_PREFIX, specid))
            continue
        if effective not in spec_keys:
            bad("%s node %s" % (where, node["id"]),
                "effective spec %r is not present in specs{}" % (effective,))

    # Batch-node enumeration closure: from/to/expected params must partition the
    # covered JSP range without gaps or overlaps.
    batches = [
        node["params"] for node in nodes
        if isinstance(node.get("params"), dict) and {"from", "to", "expected"} <= set(node["params"])
    ]
    if batches:
        ordered = sorted(batches, key=lambda params: params["from"])
        cursor = ordered[0]["from"]
        gaps = []
        for params in ordered:
            if params["from"] != cursor:
                gaps.append("expected %d, got %d" % (cursor, params["from"]))
            cursor = params["to"] + 1
        check(not gaps, "%s: batch ranges partition JSP-%06d..%06d" % (where, ordered[0]["from"], ordered[-1]["to"]),
              "; ".join(gaps))
        check(all(isinstance(params["expected"], int) and params["expected"] >= 0 for params in ordered),
              "%s: every batch declares an integer expected count" % where)
        return ordered
    return []


def main():
    parser = argparse.ArgumentParser(description="Validate the MetaTask wave-1 campaign drafts.")
    parser.add_argument("--drafts", default=DEFAULT_DRAFTS)
    parser.add_argument("--artifacts", default=DEFAULT_ARTIFACTS)
    parser.add_argument("--readme", default=DEFAULT_README)
    args = parser.parse_args()

    drafts = load_json(args.drafts, "drafts")
    artifacts_doc = load_json(args.artifacts, "artifacts")
    if drafts is None or artifacts_doc is None:
        report()
        return 1

    # ---- staging keys -----------------------------------------------------
    offending = sorted({key for _, key, _ in walk_keys(drafts) if key in STAGING_KEYS})
    check(not offending, "drafts: no staging keys the tool does not understand",
          "" if not offending else "found %s" % offending)

    # ---- specs ------------------------------------------------------------
    specs = drafts.get("specs")
    if not check(isinstance(specs, dict) and specs, "drafts.specs: non-empty map of spec key -> spec object"):
        report()
        return 1
    spec_keys = set(specs)
    plan = drafts.get("specPinPlan", {})
    check(isinstance(plan, dict) and set(plan) == spec_keys,
          "drafts.specPinPlan: one plan entry per spec key",
          "plan=%s specs=%s" % (sorted(plan), sorted(spec_keys)))

    artifacts = {entry.get("key"): entry for entry in artifacts_doc.get("artifacts", []) if isinstance(entry, dict)}
    check(len(artifacts) == len(artifacts_doc.get("artifacts", [])), "artifacts: every entry has a unique key")

    for key, spec in sorted(specs.items()):
        where = "spec %s" % key
        if not isinstance(spec, dict):
            bad(where, "not an object")
            continue
        unknown = sorted(set(spec) - TOOL_SPEC_FIELDS)
        check(not unknown, "%s: only tool spec fields" % where, "" if not unknown else "unknown keys %s" % unknown)
        check(isinstance(spec.get("name"), str) and spec["name"].strip(), "%s: name present" % where)
        check(isinstance(spec.get("lang"), str) and spec["lang"].strip(), "%s: lang present" % where)
        entry = spec.get("entry")
        check(isinstance(entry, str) and entry.strip(), "%s: entry present" % where)

        script = spec.get("script")
        if check(isinstance(script, str) and script.strip(), "%s: script inlined (non-empty)" % where):
            local = os.path.join(HERE, entry) if isinstance(entry, str) else None
            if local and os.path.isfile(local):
                with open(local, "r", encoding="utf-8") as handle:
                    check(handle.read() == script,
                          "%s: inline script is byte-identical to %s" % (where, entry))
            else:
                check(False, "%s: entry %r has no standalone file" % (where, entry))
        check(spec.get("input") not in (None, ""), "%s: input descriptor present" % where)
        check(spec.get("output") not in (None, ""), "%s: output descriptor present" % where)

        validation = spec.get("validation")
        if not check(isinstance(validation, dict), "%s: validation block present" % where):
            continue
        missing_items = [item for item in VALIDATION_ITEMS if item not in validation]
        check(not missing_items,
              "%s: validation block carries all three protocol items" % where,
              "" if not missing_items else "missing %s (extra keys are allowed)" % missing_items)
        check(validation.get("null_tolerance") is True,
              "%s: null_tolerance is boolean true" % where, "got %r" % (validation.get("null_tolerance"),))
        closure = validation.get("enumeration_closure")
        if isinstance(closure, dict):
            check(isinstance(closure.get("closure"), str) and closure["closure"].strip(),
                  "%s: enumeration_closure declares the closure" % where)
            counts = find_int_counts(closure)
            check(bool(counts), "%s: enumeration_closure carries an integer expected_count self-check" % where)
        else:
            bad(where, "enumeration_closure must be an object")

        fidelity = validation.get("proposition_fidelity")
        if not isinstance(fidelity, dict):
            bad(where, "proposition_fidelity must be an object")
            continue
        check(len(list(find_bools(fidelity))) == 0,
              "%s: proposition_fidelity declares no self-attested boolean (non-compliant per protocol)" % where)
        correspondence = fidelity.get("correspondence")
        artifact_pin = fidelity.get("artifactPin")
        check(correspondence == artifact_pin and isinstance(correspondence, str),
              "%s: correspondence and artifactPin agree" % where,
              "correspondence=%r artifactPin=%r" % (correspondence, artifact_pin))
        check(correspondence == PLACEHOLDER or (isinstance(correspondence, str) and PIN_REF_RE.match(correspondence)),
              "%s: correspondence is the placeholder or a pin://|metafile:// reference" % where,
              "got %r" % (correspondence,))
        check(fidelity.get("coverage") == COVERAGE_ITEMS,
              "%s: correspondence coverage is the protocol's three items" % where,
              "got %r" % (fidelity.get("coverage"),))
        artifact_key = fidelity.get("artifactKey")
        artifact = artifacts.get(artifact_key)
        check(artifact is not None, "%s: artifactKey %r resolves in the artifacts file" % (where, artifact_key))
        if artifact is not None:
            if correspondence == PLACEHOLDER:
                check(artifact.get("publishStatus") == PLACEHOLDER and artifact.get("publishedPin") == PLACEHOLDER,
                      "%s: placeholder marking matches artifact %s" % (where, artifact_key),
                      "artifact publishStatus=%r publishedPin=%r" % (artifact.get("publishStatus"), artifact.get("publishedPin")))
            else:
                check(isinstance(artifact.get("publishedPin"), str) and PIN_REF_RE.match(artifact.get("publishedPin") or ""),
                      "%s: published artifact %s carries a pin reference (publishStatus=%r)"
                      % (where, artifact_key, artifact.get("publishStatus")),
                      "got %r" % (artifact.get("publishedPin"),))

    for key, plan_value in sorted(plan.items()):
        check(plan_value in (PLAN_STANDALONE, PLAN_BY_PUBLISH),
              "specPinPlan %s: value is a known plan" % key, "got %r" % (plan_value,))

    # ---- tasks ------------------------------------------------------------
    tasks = drafts.get("tasks")
    if not check(isinstance(tasks, list) and tasks, "drafts.tasks: non-empty list"):
        report()
        return 1
    task_ids = [task.get("id") for task in tasks if isinstance(task, dict)]
    check(len(set(task_ids)) == len(task_ids), "tasks: unique ids", "ids %s" % task_ids)

    used_spec_pins, root_specs = set(), set()
    batch_total = None
    for task in tasks:
        if not isinstance(task, dict):
            bad("tasks", "entry is not an object")
            continue
        task_id = task.get("id")
        where = "task %s" % task_id
        root_spec = task.get("rootSpec")
        if root_spec not in spec_keys:
            bad(where, "rootSpec %r is not present in specs{}" % (root_spec,))
            continue
        root_specs.add(root_spec)
        publish = task.get("publish")
        if not isinstance(publish, dict):
            bad(where, "publish payload missing (must hold the metatask_publish arguments)")
            continue
        unknown = sorted(set(publish) - TOOL_TASK_FIELDS)
        check(not unknown, "%s: publish payload uses only tool fields" % where, "" if not unknown else "unknown keys %s" % unknown)
        check("spec" not in publish, "%s: the root spec comes from rootSpec, not publish.spec" % where)
        check(isinstance(publish.get("title"), str) and publish["title"].strip(), "%s: title present" % where)
        check(isinstance(publish.get("brief"), str) and publish["brief"].strip(), "%s: brief present" % where)
        if publish.get("tags") is not None:
            check(isinstance(publish["tags"], list) and all(isinstance(tag, str) for tag in publish["tags"]),
                  "%s: tags are strings" % where)
        validate_policy(publish.get("policy"), where)
        ordered_batches = validate_tree(task_id, publish.get("nodes"), spec_keys, root_spec)
        if ordered_batches and plan.get(root_spec) == PLAN_BY_PUBLISH:
            total = sum(params["expected"] for params in ordered_batches)
            batch_total = total if batch_total is None else batch_total + total
            closure_counts = find_int_counts(specs[root_spec].get("validation", {}).get("enumeration_closure", {}))
            check(total in closure_counts,
                  "%s: Σ batch expected counts (%d) reconciles with %s's enumeration_closure self-check %s"
                  % (where, total, root_spec, closure_counts))
        for node in publish.get("nodes") or []:
            specid = node.get("specid")
            if isinstance(specid, str) and specid.startswith(SPEC_PIN_PREFIX):
                used_spec_pins.add(specid[len(SPEC_PIN_PREFIX):])

    for key, plan_value in sorted(plan.items()):
        if plan_value == PLAN_STANDALONE:
            check(key in used_spec_pins, "specPinPlan %s: standalone pre-pass spec is referenced by a node override" % key)
        else:
            check(key in root_specs, "specPinPlan %s: published-as-root spec is some task's rootSpec" % key)
    for key in sorted(used_spec_pins):
        check(key in spec_keys, "node override %s%s resolves" % (SPEC_PIN_PREFIX, key))
        check(plan.get(key) == PLAN_STANDALONE,
              "node override %s%s is planned as a standalone pre-pass pin" % (SPEC_PIN_PREFIX, key),
              "plan=%r" % (plan.get(key),))

    # ---- held -------------------------------------------------------------
    held = drafts.get("held")
    if check(isinstance(held, list) and held, "drafts.held: documented HELD list present"):
        held_ids = [entry.get("id") for entry in held if isinstance(entry, dict)]
        for entry in held:
            if not isinstance(entry, dict):
                bad("held", "entry is not an object")
                continue
            if not (isinstance(entry.get("reason"), str) and len(entry["reason"].strip()) >= 40):
                bad("held %s" % entry.get("id"), "reason missing or too short to document the demotion")
            if not isinstance(entry.get("verifierReady"), bool):
                bad("held %s" % entry.get("id"), "a HELD entry must state verifierReady: true|false")
        overlap = sorted(set(held_ids) & set(task_ids))
        check(not overlap, "held: no HELD id is also a published task", "overlap %s" % overlap)

    # ---- artifacts --------------------------------------------------------
    for key, artifact in sorted(artifacts.items()):
        where = "artifact %s" % key
        check(artifact.get("coverage") == COVERAGE_ITEMS,
              "%s: covers the protocol's three fidelity items" % where,
              "got %r" % (artifact.get("coverage"),))
        check(isinstance(artifact.get("formalizedStatement"), str) and len(artifact["formalizedStatement"].strip()) >= 40,
              "%s: formalized statement recorded" % where)
        check(isinstance(artifact.get("divergenceRisks"), list) and artifact["divergenceRisks"],
              "%s: divergence risks recorded" % where)
        if artifact.get("scope") == "record":
            check(isinstance(artifact.get("recordStatementVerbatim"), str) and artifact["recordStatementVerbatim"].strip(),
                  "%s: quotes the bank record verbatim" % where)
            provenance = artifact.get("recordProvenance")
            check(isinstance(provenance, dict) and provenance.get("source") and provenance.get("fetchedAt"),
                  "%s: record provenance recorded" % where)
        check(artifact.get("publishedPin") == PLACEHOLDER or PIN_REF_RE.match(artifact.get("publishedPin") or ""),
              "%s: publishedPin is the placeholder or a pin reference" % where)

    # ---- runbook ----------------------------------------------------------
    if os.path.isfile(args.readme):
        with open(args.readme, "r", encoding="utf-8") as handle:
            readme = handle.read()
        missing_tasks = [task_id for task_id in task_ids if task_id not in readme]
        check(not missing_tasks, "README: names every wave-1 task", "missing %s" % missing_tasks)
        held_id_tokens = [token for entry in (held or []) if isinstance(entry, dict)
                          for token in re.findall(r"[A-Z0-9-]+JSP-\d{6}|JSP-\d{6}", str(entry.get("id", "")))]
        missing_held = [token for token in held_id_tokens if token not in readme]
        check(not missing_held, "README: names every HELD id", "missing %s" % missing_held)
        check(PLACEHOLDER in readme, "README: documents the publish placeholder %s" % PLACEHOLDER)
        check("metatask_amend" in readme, "README: documents the wave-1 no-amend policy")
        check(SPEC_PIN_PREFIX in readme, "README: documents the %s spec-pin substitution" % SPEC_PIN_PREFIX)
    else:
        bad("README", "not found at %s" % args.readme)

    # ---- summary ----------------------------------------------------------
    print("wave-1 composition: %s" % ", ".join(str(task_id) for task_id in task_ids))
    nodes_total = sum(len(task.get("publish", {}).get("nodes", [])) for task in tasks if isinstance(task, dict))
    print("tasks=%d nodes=%d specs=%d artifacts=%d held=%d batch_expected_total=%s"
          % (len(tasks), nodes_total, len(specs), len(artifacts), len(held or []), batch_total))
    return report()


def report():
    print("\n".join(checks))
    if errors:
        print("\nDRAFTS NOT PUBLISH-READY — %d failure(s):" % len(errors))
        for message in errors:
            print("  - %s" % message)
        return 1
    print("\nDRAFTS PUBLISH-READY — every check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
