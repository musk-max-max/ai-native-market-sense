# v7 证据等价报告（v6-124entries → v7-2523256）

- 生成时间：2026-11-04T07:32Z（15:32 +08:00）
- 执行人：A11（qa-contract-data）
- 定义依据：H4 m03485；定义写死在脚本 `EVIDENCE_PREFIXES` / `EVIDENCE_FILES` / `ALLOWED_NON_EVIDENCE_CHANGES`
- 脚本 sha256：`4706aff353403eb44e5d32bbcc27209b0d7764a668a1b4e67597bfcd50c7ecfd`
- v7 tar：`75f89a2dc92f64c7995edfc7a33696efbd245bb081cc782006f0400b78bc7d8f`（4,138,568B）；包内 manifest：`c2cc1de5823c1d480c2804b318c41fbc86b994d785f7716f64b26993c5e28d54`；`packed_from_commit=25232563fea2e0d546a6cb1859da6e677efb8404`；commit D=`17853c6`；v7 字节未改。

## 命令

```
$ python3 tests/data/acceptance/check_version_equivalence.py \
    --previous tests/data/acceptance/artifacts/11-12-evidence-20261104-v6.tar.gz \
    --current  tests/data/acceptance/artifacts/11-12-evidence-20261104-v7-2523256.tar.gz
```

## 原样输出（stdout）

```
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
```

```
EXIT=0
```

stderr：`(空)`

## 非证据变更 7 条（旧/新 sha256 + 分类）

| path | v6 sha256 | v7 sha256 | 分类 | 理由 |
|---|---|---|---|---|
| `ADVERSARIAL.md` | `1f001088e38f49f9a92cdf78f5bbe040035ab40053b784cd50314a21629bed68` | `4bf387a483883a351a1156e54bb2c014d13a9dd54bc469949f04767d585e6ba4` | doc | 追加 v7 绑定段（四元组/packed commit/predecessors） |
| `git-info.txt` | `18efbffa72f6aa4b04bf2c0252ed9e895605c954b194129f1a91475165013739` | `b2d60f7256420d8ccca9547768797af2732a2468bcbc433726338566e40e58a4` | meta | `packed_from_commit` 162ac41 → 2523256 |
| `tests/contract/CI_MOUNT.md` | `0f02c785fdbb1510fdac2a367988d72889a13b8d6d301f01edb8b0edbb615584` | `d17f83a30b1f4a498a79d6eea454b263070355bf516380d07231926f2dd4738b` | doc | 回填 v7 四元组、四门禁、A19 复核结论、等价范围定义（65 条） |
| `tests/data/acceptance/build_evidence_manifest.py` | `fa1a8c8f510e27ae55bce0547e9fcf9218fc3033c4ece493a26a000fd717f877` | `fae7d00d2317c3c585a9d5f63c5270d4858230b86420dc23975faf226e528644` | tool | 增加 `--predecessors` / `--packed-from-commit` |
| `tests/data/acceptance/check_pack_matches_head.py` | `09e71b5b9fd9f020007742b596c72653b4a7d1096c82247fa22b72a5ffbe9861` | `9e2cc5568b2d20e4dc10aab9b29ada1639aea992937c241231c7a4e8a2f0bd1a` | tool | 增加 `--map` / `--allow-prefix` / `--commit` |
| `tests/data/test_evidence_manifest.py` | `7c866c759408978c85b1040aa6fc5a944f699d5cd0c23740c23baf3588580302` | `324285543cc1e29268ac4fec4d1ecb07fbab0f4c2164b8ce405d5e46145ca0ac` | tool | 指向 commit 后缀文件名 + predecessors 断言 |
| `tests/data/test_pack_matches_head.py` | `56cf959f547211b35839d0d1194f0ae1113c9befadfe79ab286c01c33d0842f4` | `223ffd0b863543e2e8e167e503a21355c6dcab20ee2a5e3b9d85acebb899708a` | tool | 指向 commit 后缀文件名 + v7 绑定断言 |

> 说明：证据计数按 H4 定义 = 65（早期 88 是收窄前口径，含 `infra/`、`tests/data/acceptance/` 等非证据路径；CI_MOUNT 已同步为 65）。
