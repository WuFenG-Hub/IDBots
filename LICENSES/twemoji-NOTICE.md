# Twemoji — bundled asset notice

The 85 SVG files under `src/renderer/components/chat/assets/twemoji/` are
from **Twemoji** v14.0.2, downloaded verbatim from:

    https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/<codepoint>.svg

They are the exact catalog subset referenced by
`src/renderer/components/chat/twemoji.ts` (the chat emoji picker catalog in
`emojiData.ts`; upstream asset names strip the FE0F variation selector, e.g.
✌️ → `270c.svg`). Only these 85 files are bundled — not the full Twemoji set.

- Project: https://github.com/twitter/twemoji
- Copyright 2019 Twitter, Inc and other contributors
- Graphics licensed under **CC-BY 4.0**: https://creativecommons.org/licenses/by/4.0/

CC-BY 4.0 requires attribution: keep this notice with any redistribution or
reuse of the bundled files, and credit Twemoji wherever the artwork appears
in derivative distributions (the PR description for the change that
introduced these files carries the same attribution line).
