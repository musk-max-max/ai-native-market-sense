# 研究数据来源边界门禁证据（A11 薄封装）

- 生成时间（UTC）：2026-11-05T13:56:41Z
- 仓库 HEAD：`f36e63e96f2e2654ffd625d872e94ed7b2c26a8a`
- 被测工具：`services/ingest/tools/check_research_source_boundary.py`（A1 `bc118ce`，未修改）
- 输入（A1 smoke 产物）：`services/ingest/var/research-ods-smoke`、`services/ingest/var/research-ods-smoke-audit`
- 判定：正样本 exit 0；负样本①mirror+display_safe=true、②sources 含 token 均非 0；ods root 不存在 exit 2
- 结论：**PASS**

### 正样本：A1 smoke 产物（research-ods-smoke）
```
$ /opt/anaconda3/bin/python3 services/ingest/tools/check_research_source_boundary.py --ods-root /Users/leiyu/Documents/deepseek-harness/default-workspace/services/ingest/var/research-ods-smoke --json --manifest-root /Users/leiyu/Documents/deepseek-harness/default-workspace/services/ingest/var/research-ods-smoke-audit
```
exit_code: `0`
stdout:
```
{
  "checked": {
    "manifest_events": 1,
    "research_sources_files": 1
  },
  "ok": true,
  "violations": []
}
```

### 负样本①：mirror 批次 display_safe=true
输入构造：复制 A1 smoke 的 manifest root，向 manifest.jsonl **追加**一条 `channel=third_party_mirror` 且 `display_safe=true` 的 research_import 事件；其余字节不变。

```
$ /opt/anaconda3/bin/python3 services/ingest/tools/check_research_source_boundary.py --ods-root /Users/leiyu/Documents/deepseek-harness/default-workspace/services/ingest/var/research-ods-smoke --json --manifest-root <tmp>/manifest-mirror
```
exit_code: `1`
stdout:
```
{
  "checked": {
    "manifest_events": 2,
    "research_sources_files": 1
  },
  "ok": false,
  "violations": [
    "/var/folders/3z/sfqk2hr14m3gppb4j9g6j3zr0000gn/T/a11-research-boundary-tk_z7r8z/manifest-mirror/manifest.jsonl:2: mirror batch cannot be display_safe=true (channel='third_party_mirror', source_channel='third_party_mirror')"
  ]
}
```

### 负样本②：research_sources 记录含 token 键
输入构造：复制 A1 smoke 的 ODS root，向 `internal/_meta/research_sources.jsonl` **追加**一条 `{"run_id": "a11-negative", "token": "must-not-be-recorded"}` 审计记录；其余字节不变。

```
$ /opt/anaconda3/bin/python3 services/ingest/tools/check_research_source_boundary.py --ods-root <tmp>/ods-credential --json --manifest-root /Users/leiyu/Documents/deepseek-harness/default-workspace/services/ingest/var/research-ods-smoke-audit
```
exit_code: `1`
stdout:
```
{
  "checked": {
    "manifest_events": 1,
    "research_sources_files": 1
  },
  "ok": false,
  "violations": [
    "/var/folders/3z/sfqk2hr14m3gppb4j9g6j3zr0000gn/T/a11-research-boundary-tk_z7r8z/ods-credential/internal/_meta/research_sources.jsonl:2: credential-like keys ['token'] must not be recorded (H4 m03419)"
  ]
}
```

### 用法/环境错误：ods root 不存在应 exit 2
```
$ /opt/anaconda3/bin/python3 services/ingest/tools/check_research_source_boundary.py --ods-root <tmp>/does-not-exist --json
```
exit_code: `2`
stdout:
```

```
stderr:
```
ods root not found: /var/folders/3z/sfqk2hr14m3gppb4j9g6j3zr0000gn/T/a11-research-boundary-tk_z7r8z/does-not-exist
```
