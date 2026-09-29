# Wave-1 Launch Session Packet — for the publishing bot (AI_Sunny / Twin)

Paste this whole file into a chat with the publishing bot in IDBots. Everything it
needs is on disk; it must not improvise arguments.

---

You are the publisher of the MetaTask wave-1 campaign (protocol
/protocols/metatask v1.2.1, now active — chain height is past H_ACT2 191500).
Publish the four wave-1 tasks using the built-in tools `metatask_publish_spec`
and `metatask_publish`. All launch gates are already verified (three engines
green, drafts validator green, bank re-diff clean, artifact pins uploaded).

Read your arguments from this file (read it fully first):

    /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/metaskt-wave1-launch/scripts/metatask-campaign/wave1-task-drafts.json

It contains `tasks[]` (each with a ready `publish` object and `rootSpec`), a
`specs{}` map (scripts inlined, validation blocks complete with real artifact
pins), and the launch procedure. Do NOT edit the arguments, weights, policy,
spec contents, or validation blocks — they are machine-validated. Do NOT use
`metatask_amend` on a wave-1 task, ever (wave-1 trees are final at publish).

## Step 1 — publish the four standalone spec pins

Call `metatask_publish_spec` once per spec below, using the exact spec object
from `specs{}` in the drafts file (name/lang/entry/script/input/output/
validation, all of it). Keep `enforceHAct2Validation` at its default (true).

1. `specs["witness-extraction-301"]`
2. `specs["semantic-review-301"]`
3. `specs["semantic-review-870"]`
4. `specs["semantic-review-598"]`

Record the returned `specPinId` of each. If a call is refused, STOP and report
the refusal verbatim — do not retry with modified arguments.

## Step 2 — substitute node specid overrides

In each task's `publish.nodes`, replace the `SPEC_PIN:<key>` placeholders with
the real spec pin ids from step 1:

| Task | Node id | specid becomes |
| --- | --- | --- |
| T1-JSP-000301 | `witness` | specPinId of `witness-extraction-301` |
| T1-JSP-000301 | `review` | specPinId of `semantic-review-301` |
| T3-JSP-000870 | `review` | specPinId of `semantic-review-870` |
| T4-JSP-000598 | `base`, `gpt1`, `gpt2`, `review` | specPinId of `semantic-review-598` |

Nodes whose `specid` is `null` STAY null (they inherit the task root spec).
T0 has no overrides at all.

## Step 3 — publish the four tasks, in launch order

One task at a time; wait for each call to finish before starting the next.
For each task call `metatask_publish` with the task's `publish` object exactly
as given (title/brief/nodes/policy/tags after your step-2 substitution) plus
`spec = specs[<rootSpec>]`:

1. `T0-triage-287` — rootSpec `triage-table-check`
2. `T1-JSP-000301` — rootSpec `powerful-pair-verifier`
3. `T3-JSP-000870` — rootSpec `lean-build-870`
4. `T4-JSP-000598` — rootSpec `lean-build-598`

Record for every task: `taskRootPinId`, `treePinId`, `specPinId` (root spec),
and the roster pin id if one was spent. If a call is refused, STOP and report
verbatim.

## Step 4 — discovery buzz for each task (mandatory, within 24h)

Right after each task publishes, post a simplebuzz with `post_buzz`:
the task title + the FULL task root pinId + the `#metatask` tag, e.g.

    New MetaTask live: <title> — claim a node, get your work verified, earn a
    weighted contribution share. Task root: <full pinId> #metatask

## Report back

Return a single JSON object mapping every spec key and task id to its pinIds
(spec pins, root spec pins, tree pins, task root pins, roster pins), plus the
four discovery-buzz pinIds. This report is the launch record — be exact.
