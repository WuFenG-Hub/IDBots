# Wave-1 Launch Session Packet — for the publishing bot (AI_Sunny / Twin)

Paste this whole file into a chat with the publishing bot in IDBots, or tell the
bot to read it and follow it exactly. Everything it needs is on disk; it must
not improvise arguments.

---

You are the publisher of the MetaTask wave-1 campaign (protocol
/protocols/metatask v1.2.1, now active — chain height is past H_ACT2 191500).
Publish the four wave-1 tasks using the built-in tools `metatask_publish_spec`
and `metatask_publish`, both in **draftsFile mode**: you pass the drafts file
path and a key, and the tool reads the machine-validated arguments itself.
Never re-type or re-emit the draft contents by hand.

The drafts file (read it for reference, but always let the tools load it):

    /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/metaskt-wave1-launch/scripts/metatask-campaign/wave1-task-drafts.json

All launch gates are already verified (three engines green, drafts validator
green, bank re-diff clean, correspondence artifact pins uploaded and filled
into the drafts). Do NOT edit the drafts file. Do NOT use `metatask_amend` on a
wave-1 task, ever (wave-1 trees are final at publish).

## Step 1 — publish the four standalone spec pins

Call `metatask_publish_spec` four times, each time with ONLY these two
arguments (plus defaults):

1. `draftsFile` = the drafts path above, `specKey` = `"witness-extraction-301"`
2. `draftsFile` = the drafts path above, `specKey` = `"semantic-review-301"`
3. `draftsFile` = the drafts path above, `specKey` = `"semantic-review-870"`
4. `draftsFile` = the drafts path above, `specKey` = `"semantic-review-598"`

Record each returned `specPinId`. If a call is refused, STOP and report the
refusal verbatim — do not retry with modified arguments.

## Step 2 — publish the four tasks, in launch order

One task at a time; wait for each call to finish before starting the next.
Call `metatask_publish` with `draftsFile` = the drafts path, `taskId`, and
`specPinByKey` mapping the spec keys from step 1 to the real pin ids:

1. `taskId` = `"T0-triage-287"`, `specPinByKey` = `{}`
2. `taskId` = `"T1-JSP-000301"`,
   `specPinByKey` = `{ "witness-extraction-301": "<pinId from step 1.1>", "semantic-review-301": "<pinId from step 1.2>" }`
3. `taskId` = `"T3-JSP-000870"`,
   `specPinByKey` = `{ "semantic-review-870": "<pinId from step 1.3>" }`
4. `taskId` = `"T4-JSP-000598"`,
   `specPinByKey` = `{ "semantic-review-598": "<pinId from step 1.4>" }`

The tool substitutes the node specid overrides itself. Record for every task:
`taskRootPinId`, `treePinId`, root `specPinId`, and the roster pin id if one
was spent. If a call is refused, STOP and report verbatim.

## Step 3 — discovery buzz for each task (mandatory, within 24h)

Right after each task publishes, post a simplebuzz with `post_buzz`:
the task title + the FULL task root pinId + the `#metatask` tag, e.g.

    New MetaTask live: <title> — claim a node, get your work verified, earn a
    weighted contribution share. Task root: <full pinId> #metatask

## Report back

Return a single JSON object mapping every spec key and task id to its pinIds
(spec pins, root spec pins, tree pins, task root pins, roster pins), plus the
four discovery-buzz pinIds. This report is the launch record — be exact.
