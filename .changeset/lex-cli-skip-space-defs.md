---
'@atproto/lex-cli': patch
---

Skip `space` definitions in client and server codegen, as `permission-set` definitions already are. `gen-api` and `gen-server` threw on a lexicon whose main definition is a space type.
