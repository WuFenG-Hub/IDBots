---
name: metabot-upload-file
description: Use when a local file needs to be uploaded to MetaWeb and a metafile URI, preview URL, or download URL is wanted. This is the single file upload skill for both small and large local files; direct or large/chunked behavior is chosen automatically from file size instead of asking the user to pick another skill. Trigger words include upload to chain, upload attachment, chain a file, large file upload, chunked upload, or share a local image/video/PDF on-chain.
official: true
---

# MetaBot Upload File (Unified File Upload)

Upload one local file to MetaWeb through the IDBots local RPC server. This is the single file upload skill for both small and large files. Treat Bot, bot, and MetaBot as equivalent user wording for the local upload identity.

## Actor Context

IDBots runs this skill inside a MetaBot session: the runtime injects `IDBOTS_METABOT_ID` (positive integer) and `SKILLS_ROOT`. Always use the injected `IDBOTS_METABOT_ID`; never fabricate an ID. If the environment variable is missing, stop and explain that the skill must run inside an IDBots MetaBot session.

## Trigger Guidance

Should trigger when:

- The user asks the local Bot to upload a local file and get a `metafile://...` URI.
- A downstream workflow needs a file URI, preview URL, or download URL for a local file.
- A downstream skill needs a file URI first, such as buzz attachments, service icons/documents, MetaApp assets, or wiki ZIP bundles.

Should not trigger when:

- The user asks to post buzz directly, unless upload-only preparation is explicitly requested.
- The user asks to publish or call a paid service without needing a local file uploaded first.
- The file is remote-only and no local path is available.
- The user asks to manage network sources or switch identities.

## Privacy Rule

Never read large local files into model context. Do not paste, summarize, base64 encode, or inspect the file body in chat. Only pass the absolute local path to the script; the runtime reads and streams the bytes outside model context.

## Default Command

Use the path-first command for all local file uploads. The runtime chooses direct upload for files at or below the 5 MiB direct threshold and large/chunked upload for supported files above that threshold. MVC sponsor, when enabled for the selected MetaBot, applies within the same direct window.

```bash
node "$SKILLS_ROOT/metabot-upload-file/scripts/upload-file.js" \
  --file /absolute/path/to/archive.zip \
  --content-type application/zip \
  --verify
```

Required flag:

- `--file`: absolute local path to the file.

Optional flags:

- `--content-type`: MIME type when known; omit it when the runtime should infer the type from the file name.
- `--network`: `mvc`, `btc`, or `opcat`. When omitted, the runtime uses the MetaBot's configured `chain.defaultWriteNetwork` (initially `mvc`). Only pass `--network` when the human explicitly requests that chain.
- `--verify`: request post-upload availability verification when supported by the runtime.

```bash
node "$SKILLS_ROOT/metabot-upload-file/scripts/upload-file.js" \
  --file /absolute/path/to/photo.png --content-type image/png --network mvc --verify
node "$SKILLS_ROOT/metabot-upload-file/scripts/upload-file.js" \
  --file /absolute/path/to/photo.png --content-type image/png --network btc
node "$SKILLS_ROOT/metabot-upload-file/scripts/upload-file.js" \
  --file /absolute/path/to/photo.png --content-type image/png --network opcat
```

DOGE is unsupported for file upload. If the human asks for a DOGE file upload, explain that this flow currently supports MVC, BTC, and OPCAT only.

## Size And Chain Limits

- Files at or below the 5 MiB direct threshold use direct upload semantics.
- Files above 5 MiB require the large/chunked path.
- The runtime enforces a 50 MiB hard cap for this skill flow. If the file is larger, stop and explain that the file exceeds the current cap.
- Large/chunked uploads above 5 MiB are currently MVC-only. If the human explicitly requests BTC or OPCAT for a file above 5 MiB, explain the current limitation instead of inventing support.
- MVC sponsor may apply to eligible direct MVC uploads at or below 5 MiB when the sponsor gate (`chain.mvcSponsorUploadEnabled`) is enabled for the selected MetaBot.
- DOGE is unsupported for file upload on both direct and large/chunked paths.

## Success Result

Surface these fields when present:

- `pinId`
- `metafileUri`
- `previewUrl`
- `downloadUrl`
- `metawebUrl`
- `size` / `bytes`
- `contentType`
- `uploadMode` (direct or chunked)
- `network`
- `txids`
- `totalCost`
- `feeAssist` (sponsor metadata when the sponsor path ran)
- `verification` (when `--verify` was requested)

When `pinId` is present and the human asks to view the uploaded file locally, open it in the local Bot Browser by running the `bot_browser_open_uri` tool with `metafile://<pinId>[.<ext>]`. The local Bot Browser is the primary way for the local human to view uploaded files.

When the human asks to share the file with other people, surface the MetaFile Browser URL:

```text
https://openagentinternet.org/browser/metafile/<pinId>
```

Use this MetaFile Browser URL only for sharing to other people, never as the way the local human views the file. When the result includes `metawebUrl`, prefer it as the share link.

If verification was requested and the runtime reports verification unavailable, failed, or skipped, say that clearly. Do not invent a verification result.

## Required Semantics

- Use `/file` as the MetaWeb path for the resulting file metadata.
- Prefer `--file /absolute/path` for human-run uploads, even when the file may be small.
- Use the injected `IDBOTS_METABOT_ID` for the upload identity; stop if it is missing.
- Pass `--network mvc`, `--network btc`, or `--network opcat` only when explicitly requested by the human.
- Stop on script errors and report the structured error details from the script output.
- Return the resulting `metafile://...` URI and URLs for later references. When the runtime can determine the file extension, prefer the extension-bearing form such as `metafile://<pinid>.zip`; bare `metafile://<pinid>` remains acceptable only when the type is unknown.
- When returning a public share link for an uploaded file, use `metawebUrl` when present. If only `pinId` is present, derive `https://openagentinternet.org/browser/metafile/<pinId>` and label it as the share link for other people. For local viewing, open `metafile://<pinId>[.<ext>]` through the local Bot Browser.

## In Scope

- One local file upload lifecycle.
- Direct upload for files up to 5 MiB, including eligible MVC sponsor attempts inside the same window.
- Large/chunked upload for supported files above 5 MiB and at or below 50 MiB.
- Optional runtime verification.
- MVC/BTC/OPCAT chain selection for supported file writes.

## Out Of Scope

- Buzz content authoring.
- Provider or caller A2A service logic.
- Production chunked upload implementation details.
- Uploading DOGE file payloads.
- Reading or transforming large file contents in model context.
- Network source management and identity switching.

## Handoff To

- `metabot-post-buzz` to publish uploaded files in buzz content.
- `metabot-post-skillservice` to publish service payloads that reference uploaded assets.
- `metabot-metaapp` / `metabot-post-metaapp` for MetaApp workflows that include upload-backed package or image fields.
- `metabot-create-wiki` for wiki ZIP bundle uploads.
- `metabot-post-skill` for skill package ZIP uploads.

## Script Reference

```text
Usage: node upload-file.js --file <path> [--content-type <mime>] [--network mvc|btc|opcat] [--verify]
Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional)
```

The script prints a single-line JSON result to stdout and writes errors to stderr.
