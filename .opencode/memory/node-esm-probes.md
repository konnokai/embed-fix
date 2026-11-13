---
name: Node.js ESM probes
description: Node.js inline probe 混用 top-level await 和 require 時的失敗及替代方式。
---

Node.js 26.13.0 的 `node -e` probe 若同時使用 top-level `await` 和 `require()`，會以 `ERR_AMBIGUOUS_MODULE_SYNTAX` 失敗。改用 `.mjs` 腳本，並從 `node:fs/promises` 等模組使用 `import`，本次可正常執行（2026-11-13）。版本或模組模式變更後需重新確認。
