# 11-12 主数据 manifest 样例（A1 → H4）

**全部为 synthetic 样例，不是真实抓数、没有访问任何网络**：CSV 用仓库内
`data/instruments/base_info.csv`（5 只占位），条款文本是占位文件，下载地址是
`example.invalid`。真实渠道与条款口径等 H4 m01064/§11-12 结论。

## 生成方式（可复现）

工作目录 `services/ingest/`：

```bash
# 成功批：CSV 主数据导入（写 display root + manifest + 条款快照）
PYTHONPATH=src python -m market_ingest sync-instruments --source csv \
  --csv-file ../../data/instruments/base_info.csv \
  --ods-root samples/h4-audit/run/ods --db samples/h4-audit/run/ingest.db \
  --manifest-root samples/h4-audit/run/audit --operator synthetic-a1 \
  --channel manual_import --source-url https://example.invalid/master-v1.csv \
  --terms-version v0-synthetic --terms-file samples/h4-audit/terms-synthetic.txt \
  --credential-ref synthetic-credential

# blocked 批：同一批里改名但不给公告依据 → 冲突阻断，不写 ODS，exit 4
PYTHONPATH=src python -m market_ingest sync-instruments --source csv \
  --csv-file samples/h4-audit/base_info_v2_rename_no_basis.csv \
  ...同参数（source-url 换成 master-v2.csv）
```

## 文件

| 文件 | 证明什么 |
|------|----------|
| `run/audit/manifest.jsonl` | append-only 事件流：成功批、blocked 批、以及一条 `channel=tushare`（`display_safe=false`）的交叉校验事件 |
| `run/audit/terms/dc12e2ab….txt` | 条款全文快照，sha256 内容寻址（文件名=哈希）；manifest 里同时记 `terms_version` / `terms_snapshot_sha256` |
| `run/audit/snapshots/instruments-f2a12644….json` | 该批 canonical 行快照，供下一版 diff / display_safe 派生（A2 读这个） |
| `run/ods/display/instrument/dt=…/ing-…-instrument.json` | 只落 display root 的 `instrument.v1` 批次（5 行） |
| `blocked-conflicts.txt` / `blocked-output.json` | 冲突 diff 与阻断结果（exit 4、无 ODS 批次、manifest `status=blocked`） |
| `base_info_v2_rename_no_basis.csv` | 冲突输入样本（600519 改名、`change_basis_url` 留空） |

## 关键口径（m00801 / m01064 / L34）

- 事件写一次、无覆盖/删除接口；失败/中断/blocked 也写事件。
- 操作人必填；凭证只记 `env:TUSHARE_TOKEN` 或 sha256 路径，不落明文。
- 三类自动阻断：代码唯一性、名称↔代码映射、退市/更名无公告依据；≤5 条出 diff 提交人工终审（本样例 1 条 → blocked），>5 条整批退回。
- `channel=tushare` 仅内部交叉校验：`display_safe=false`；C 端展示只信 `display_root` 且 `entitlement_ok AND display_safe`。
- 告警不依赖 IM：退出码非 0 + manifest blocked 事件 + 日志。

## 环境事实（H4 问的 manifest 落盘前提）

`infra/helm/market-sense/templates/deployment-worker.yaml`：worker 容器
`readOnlyRootFilesystem: true`，只挂 `/tmp` emptyDir，无 PVC。**因此生产 manifest
不能放容器内 `var/audit`（重启即丢、不是审计证据）**，必须 PVC 或对象存储；
本地/CI/compose 用仓库内或挂载卷可以。A1 侧已把 manifest root 做成显式参数
（`--manifest-root` / `imports.manifest_root`），落盘容器由 A13 决定。
