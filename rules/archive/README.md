# 签认字节归档（L130 / owner/H3 要求）

任何一个被签认过的 `rules/*.json` 字节都必须可按 sha256 取回；签认前归档 pending 字节，签认后归档最终字节。归档文件只读、不可覆盖，文件名即文件的 sha256。

- `rules/archive/ai-content-policy/<sha256>.json`
- `rules/archive/redline-basis/<sha256>.json`

CI 校验：`packages/ai-policy/test/archive.test.ts` 遍历上述目录，断言每个文件名等于文件内容 sha256；mismatch 即失败。新增归档只能追加，不得改写已有文件。
