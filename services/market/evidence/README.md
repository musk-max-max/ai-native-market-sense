# A3 证据目录规矩（H4 m02218 定稿）

1. **artifact 是纯数据，不得内嵌自己的哈希**。哈希放 sidecar 或 manifest，例如
   `<artifact>.sha256` 或本目录 `MANIFEST.md`；证据正文不追加"自指 hash 行"。
2. 哈希按字节算（`shasum -a 256`），不做换行归一化；权限/mtime 记录但不入哈希。
3. 一份证据只有一个权威 sha；历史/前缀哈希若必须出现，必须在 manifest 里写明
   "对应哪段字节"，不能让复算人猜。
   **receipt 本身也是 artifact**：进 `MANIFEST.json` 时带自己的 sha256，否则
   "凭证说文件是 X"而凭证被改过，链路又断。manifest 作为索引，不内嵌自己的哈希。
4. 已冻结文件不改，保持可追：`hold-unreachable-raw-20261104.txt`
   （sha256 `f80562cab1225e2790805154bc1459210d0b1b681eaf8d018adf144bfabdaf67`，2506B）
   末尾自指行是历史例外（保留原字节，不抹平）：在 `MANIFEST.json` 的 `errata`
   字段留痕，权威值见该 manifest 与 `RECEIPT-hold-unreachable-20261104.md`；
   今后新证据按第 1 条执行。
5. 证据须标运行 profile（如 `APP_PROFILE=test`）与复算人/时间/命令，见 RECEIPT 格式。

## 复算

```
shasum -a 256 services/market/evidence/hold-unreachable-raw-20261104.txt
# f80562cab1225e2790805154bc1459210d0b1b681eaf8d018adf144bfabdaf67
```
