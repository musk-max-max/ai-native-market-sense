# serving 视图与质量门禁复核（AKshare 落仓口径衔接准备）

- 日期：2026-11-06；复核人：A2（数仓）；任务来源：lead 派单（本轮首任务）。
- 对照：prd-v2.md §2.1/§2.2、§10.4 P1-7（AC-P17-4/AC-P17-6）、brd-c-end.md MKT-01..08。
- **口径来源勘误**：仓库无 FR-MKT-19、无 "v2-2.1" 字面节号（全库 grep 无命中）；BRD 功能编号为 MKT-01..08。按最接近语义复核 PRD §2.1/§2.2（信息架构/服务面）+ BRD MKT 数据依赖。请派单方确认编号出处。

## 一、门禁复核结果（本机，2026-11-06 17:32–17:36）

| 命令 | 结果 | 判定 |
|---|---|---|
| `python3 -m pytest warehouse/tests data/golden -q` | 200 passed, 1 skipped（test_load.py:346 需真实 PG_TEST_DSN，本机无 DSN） | 绿 |
| `python3 -m pytest tests/data -q` | 161 passed | 绿 |
| `python3 -m pytest tests/contract -q` | 69 passed | 绿 |
| `python3 -m pytest warehouse/tests/test_quality.py -q` | 16 passed | 绿 |
| golden 正负例（test_golden.py 内嵌断言） | 37 正（G01–G37）+ 12 负（N01–N12），与 M04 时点规则逐条对齐（G25/G26 ST 2026-07-06 边界、G29 S 股、G30/G31 北交所、G32–G37 新股前 5 日 NULL） | 绿 |

质量四类全覆盖（STRUCT/BIZ/COMP/CONS + RES 共 23 条，RULE_META=quality_config 对齐）、blocker 阻断下游（load.py:637 gate_reason red/black/blocked 拒写）、历史修正留版本告警（dwd_bar_revision + golden revision 负例）——硬规则 3/4/5/6 均有实现与用例覆盖。

## 二、发现清单

### F1【高，落仓前置】serving_quote_latest.limit_pct 与 H4 签发 M04 口径漂移

`warehouse/serving/schema.sql:68-73` 内联 limit_pct 仍为作废旧口径（H4 2026-11-05 补签后旧「主板 ST 一律 5%」已废）：

| 场景 | M04 现行口径（warehouse/metrics/m04_limit_status.sql，已进 P0-metrics.md） | serving_quote_latest 现状 | 后果（当前日期 2026-11-06） |
|---|---|---|---|
| 主板 ST/*ST | <2026-07-06→5%，≥2026-07-06→**10%** | 恒 5% | ST 股 +6% 日波被误标 limit_up/down |
| 主板 S 股（S 开头非 ST） | 5%（优先于 ST 判定） | 无此规则→10% | 误标反向 |
| 首日 / 注册制新股前 5 交易日 | NULL（无涨跌幅） | 10/20% | 新股误标 |
| gem<2020-08-24 / star<2019-07-22 / bse<2021-11-15 | 10% / NULL / NULL | 20/20/30% | 退市/久远 bar 误标 |
| 未知板块 / listed_at NULL | limit_status NULL（fail-closed，「不知道」≠「未达涨跌停」） | 静默 'none' | 把「未知」展示为「未涨停」 |

根因：serving 视图内联实现未随 M04 口径变更同步；且无任何测试将视图 limit_pct 与 M04 SQL 对照（test_docs_sql_sync 只管 docs↔metrics SQL 逐字节一致，test_serving_sync 只管 ports↔schema↔README 同源）——F1 处于门禁盲区。AKshare 落仓会带全市场真实数据（含 ST/S 股/新股），此 bug 将在落仓当天即在 C 端可见。

修复建议（待派单）：serving_quote_latest 的 priced CTE 复用 M04 时点规则（或物化 dwd 层 limit 结果并引用），加一条对照测试（同一 state 跑 M04 SQL 与视图断言一致）+ golden 双校验（硬规则 3）。预估 0.5–1 天（含 PG 复验）。

### F2【低】schema 注释失实
`warehouse/serving/schema.sql:32` 注释引用错路径（docs/metrics/→实为 warehouse/metrics/）且复述作废口径「主板 ST/*ST 5%」。本次已做注释订正（纯注释，无 SQL 行为变更）。

### F3【需 H2/H4 裁定，阻塞 F1 修复形态】契约 NULL 语义
ports.yaml QuoteRow.limit_status 为非空三值枚举 [none,limit_up,limit_down]，而 M04 对无涨跌幅日/未知板块输出 NULL。修复 F1 时需裁定：无涨跌幅日出 'none'（=未触涨停，语义勉强成立）还是契约加 null（破坏性变更→走 A3/H2）。倾向：契约加 `nullable` 并区分「未达涨跌停」与「无涨跌幅限制」，但属跨域契约变更，先上报。

### F4【中，报 PRD 责任方】AC-P17-4 计数陈旧
prd-v2.md:641 写「golden 30/30（21 正 + 9 负）」，实际门禁为 37 正 + 12 负（test_golden.py 断言）。docs/requirements/ 非 A2 写域，请 lead 转 PRD 责任方更新，否则 AC 验收会对不上。

### F5【中，AKshare 落仓核心风险】质量门禁只覆盖单次 load 窗口，跨批次拼接无覆盖
load.py:758 `run_quality_checks(state)` 的 state = build_dwd(本次 batches)，COMP-03 工作日覆盖、CONS-01 prev_close 连续性均只在本次批次窗口内判定。真库实证（PG16@55432 market_sense，只读查询）：
- dwd_stock_bar_daily 同一 instrument 混源：SSE:600519 / SZSE:000001 各自 series = tushare(2024-01-02..04) + fixture(2026-11-03、2026-11-05)，source 按 `string_agg(distinct source)` = "fixture,tushare"；
- 拼接缝存在 2024-01→2026-11 约 2 年工作日空洞、以及 2026-11-04（周三）缺日且无停牌证据——按 COMP-03 口径应为 blocker，但从未被任何一次 load 的门禁看见；
- serving_quote_latest 当前 2 行（茅台/平安），latest bar source=**fixture**，价格是假数据（与 P1-7 交接描述一致）。
落仓前置：AKshare 批次将同样拼接到既有历史，须补「落库后全序列体检」（对 serving 可见面跑 COMP-03/CONS-01 跨源重查）或规定单源全量重灌 + 切换日门禁，否则 serving_bar_daily K 线会带未告警的断档/换源缝。属新增检查（需 config/规则号），建议走 quality_config v6 + H4 确认。

### F6【中，落仓前置】fixture 数据 display_safe=true 无门禁
真库 dim_instrument 两行 source='fixture' 但 display_safe='t'。loader 只拦 synthetic:true 事件声明 display_safe:true；source 名 'fixture' 本身不参与 display_safe 判定，RULE_META 23 条也无「display_safe=true 要求 source ∈ 白名单/非合成」规则。AKshare 落仓同一问题会以另一形态出现：什么渠道/什么 source 允许 display_safe=true（L34+H4 只认 manual_import/authorized_download/official_api 三渠道，AKshare 走哪个渠道未裁定——参考 tushare residual 授权红线，AKshare（东财聚合）to-C 展示授权同样是合规缺口，需 H4/L0 裁定渠道与 display_safe 策略）。

## 三、AKshare 落仓口径衔接清单（checklist）

1. **source 命名**：canonical `^[a-z0-9_.:-]+$`（loader SOURCE_RE）自动通过；对外不出现 vendor 词（C01 HARD_VENDOR_IDENTIFIERS 含 'akshare'，只扫 contracts/ 与生成客户端）。SourceRef 封闭枚举 platform_* 无需改契约——A3 适配层已设计映射（build.ts:93-100：serving 透传内部 source，HTTP 层映射 platform_eod/platform_fundamental，原始标识进 source_id）。
2. **字段映射**：AKshare 列名（中文/驼峰）必须映射为 DWD canonical 后入 canonical 行（loader 禁 vendor 字段名、禁 JSON float）；Decimal 2dp（STRUCT-05 人民币分）。
3. **prev_close=M08 除权参考价**：AKshare 涨跌幅基准须核对是否为除权参考价；错配会在每个除权日触发 CONS-01 假 blocker。
4. **adj_factor**：只存不复权 raw + 因子（hfq=raw×factor；qfq=raw×factor/latest_factor）；不得把 AKshare 复权价存为 raw（M01/M02 口径）。
5. **COMP-02**：日线须收盘后（≥15:00+08）拉取；盘中快照不得标日 bar（PRD 不做项 #2：盘中实时不做）。
6. **换源缝（F5）**：单源全量重灌或切换日全序列体检；混源 series 必须带 source 可见。
7. **display_safe 渠道（F6）**：先裁定 AKshare 渠道归属与 to-C 授权（residual 红线同 tushare）。
8. **golden 双校验**：复权/停牌/退市新样本进 data/golden 并跑 golden 门禁（硬规则 3）。
9. **F1 先修**：否则真实 ST/S 股/新股数据落仓当天 C 端 limit_status 错误。
10. **AC-P17-6 依赖**：`import akshare` 当前 ModuleNotFoundError，A1 须落 pin（prd-v2.md:643）。

## 四、阻塞与升级项

| 项 | 裁定人 | 内容 |
|---|---|---|
| F3 | H2/H4 | limit_status NULL 语义是否进契约（阻塞 F1 修复形态） |
| F6 | H4/L0 | AKshare 数据渠道分类 + to-C 展示授权（residual 红线） |
| F4 | lead 转 PRD | AC-P17-4 golden 计数更新（30/30→37 正/12 负） |
| 编号 | 派单方 | FR-MKT-19 / v2-2.1 / v2-2.2 在仓库不存在，请给出处 |

下一步（lead 派单即可开工）：① F1 修复 + 对照测试（0.5–1 天）；② F5 全序列体检检查设计（quality_config v6）；③ AKshare adapter 样本过一遍 23 条质量规则的预检脚本。
