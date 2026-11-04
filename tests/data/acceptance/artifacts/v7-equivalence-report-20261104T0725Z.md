# v7 证据等价报告（v6-124entries → v7-2523256）

- 生成时间：2026-11-04T07:25Z（15:25 +08:00）
- 定义依据：H4 m03485（证据集定义写死在 `tests/data/acceptance/check_version_equivalence.py` 的 `EVIDENCE_PREFIXES` / `EVIDENCE_FILES` / `ALLOWED_NON_EVIDENCE_CHANGES`，非手写结论）
- 包：v6 `11-12-evidence-20261104-v6.tar.gz`（`f1e6f8e4…`）→ v7 `11-12-evidence-20261104-v7-2523256.tar.gz`（`75f89a2d…`）
- v7 tar / 包内 manifest / packed_from_commit / commit D：`75f89a2dc92f64c7995edfc7a33696efbd245bb081cc782006f0400b78bc7d8f` / `c2cc1de5823c1d480c2804b318c41fbc86b994d785f7716f64b26993c5e28d54` / `25232563fea2e0d546a6cb1859da6e677efb8404` / `17853c6`；v7 字节未改。

## 1. 命令与输出（退出码 0）

```
$ python3 tests/data/acceptance/check_version_equivalence.py \
    --previous tests/data/acceptance/artifacts/11-12-evidence-20261104-v6.tar.gz \
    --current  tests/data/acceptance/artifacts/11-12-evidence-20261104-v7-2523256.tar.gz
证据集定义：prefixes=('a19-artifacts/', 'transcripts/', 'a2-evidence/', 'services/market/evidence/') files=('a19-REPORT.md',)；v6=65 / v7=65 条
  证据计数 (root) = 1
  证据计数 a19-artifacts/ = 41
  证据计数 a2-evidence/ = 1
  证据计数 services/market/evidence/ = 7
  证据计数 transcripts/ = 15
非证据差异允许清单 = 7 条；实际变化 = 7 条
  [OK] ADVERSARIAL.md 5356B 1f001088e38f -> 5024B 4bf387a48388
  [OK] git-info.txt 60B 18efbffa72f6 -> 60B b2d60f725642
  [OK] tests/contract/CI_MOUNT.md 39655B 0f02c785fdbb -> 41264B d17f83a30b1f
  [OK] tests/data/acceptance/build_evidence_manifest.py 5670B fa1a8c8f510e -> 5972B fae7d00d2317
  [OK] tests/data/acceptance/check_pack_matches_head.py 7358B 09e71b5b9fd9 -> 7630B 9e2cc5568b2d
  [OK] tests/data/test_evidence_manifest.py 9152B 7c866c759408 -> 10824B 324285543cc1
  [OK] tests/data/test_pack_matches_head.py 5011B 56cf959f5472 -> 6488B 223ffd0b8635
包内 manifest sha256：v6=7d5488b3415d… v7=c2cc1de5823c…
PASS 证据集等价：65 个证据 path 的 bytes+sha256 全等；非证据仅允许的 7 条变化且 sha 逐一匹配
EXIT=0
```

## 2. 证据集计数（定义为准，不按 H5 的 88 对齐）

- `a19-artifacts/**` = 41（rev4 authoritative 条目 + rev3 historical + 截图 + 两个 manifest + run-scoped logs）
- `transcripts/**` = 15
- `a2-evidence/**` = 1
- `services/market/evidence/**` = 7（A3 MANIFEST、receipt、raw v4/历史 raw、errata、两档 P95 JSON、采样脚本）
- `a19-REPORT.md` = 1
- **合计 65 个证据 path，bytes+sha256 全等；缺/多/变 0 条。**

## 3. 非证据允许变更 7 条（恰好 7，多一条即门禁红）

| path | v6 sha256 | v7 sha256 | 分类 | 原因 |
|---|---|---|---|---|
| `ADVERSARIAL.md` | `1f001088…` | `4bf387a4…` | doc | 追加 v7 绑定段（四元组、packed commit、predecessors） |
| `git-info.txt` | `18efbffa…` | `b2d60f72…` | meta | `packed_from_commit` 从 `162ac41` 改为 `2523256` |
| `tests/contract/CI_MOUNT.md` | `0f02c785…` | `d17f83a3…` | doc | 回填 v7 四元组、四门禁、A19 复核结论与等价范围定义 |
| `tests/data/acceptance/build_evidence_manifest.py` | `fa1a8c8f…` | `fae7d00d…` | tool | 增加 `--predecessors` / `--packed-from-commit` / note 透传 |
| `tests/data/acceptance/check_pack_matches_head.py` | `09e71b5b…` | `9e2cc556…` | tool | 增加 `--map` / `--allow-prefix` / `--commit` 与包内-only 声明 |
| `tests/data/test_evidence_manifest.py` | `7c866c75…` | `324285543c…` | tool | 指向 commit 后缀文件名、predecessors 断言更新 |
| `tests/data/test_pack_matches_head.py` | `56cf959f…` | `223ffd0b…` | tool | 指向 commit 后缀文件名、v7 绑定断言 |

> 说明：这些路径属于文档/工具/元数据，不是被复核的证据字节；`check_evidence_manifest.py` 与 `check_pack_matches_head.py` 仍各自对 v7 全包与 commit C 做机械校验。v7 冻结后不再改动，后续变更开 v8。
