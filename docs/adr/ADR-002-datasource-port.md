# ADR-002 数据源端口与 canonical 内部模型

- **状态**：Accepted（依据 agents/decisions.md 决策 #3「数据 Python + 模块化单体」、#4「六边形端口 + canonical 模型 + 20 条 conformance」）；**H2 签字**：PENDING（随 PR；跨域数据模型变更门禁同属 H2/H4）
- **起草**：A0 arch-contract（2026-11-04）；**批准人**：H2（数据口径 H4 会签）；**影响面**：A1（ingest/adapters）、A2（warehouse/quality）、A3（market/fundamental 读侧）、A11（conformance）、A13（CI/调度）、A14（限流/配置）
- **版本**：v1.2（2026-11-04，v1.1 增补 `get_adj_factors` 为一等方法；v1.2 依 Lead m00443 将错误判定顺序改为「存在性 404 → entitlement 403 → 取数 404」，与 shared 0.2.1 对齐；变更须 A0 评审 + H4/H2 按跨域模型门禁）
- **关联**：决策 #1（契约真源）、#3（Python 数据侧）、#4（canonical + instrument_id）、C2（收盘后 ≤15min）、F1（tushare 商用授权未定）、decisions.md L1（tushare 标识豁免范围）、L3（复权因子归一，待 H4 会签）、L5（adj_factors 一等方法）、L7/L8（ODS 停牌证据行/prev_close，A1 执行）、ADR-001（契约标准）

## 背景

tushare 是 P0 唯一原始数据源，但 **F1（C 端商用/再分发书面授权）尚未落地**，未来可能换源、加源、或按授权层级切换可见范围。
若业务代码直接依赖 tushare 的接口名、字段名、代码格式（代码在前、交易所后缀在后），换源时需要改契约与所有消费方——违反「契约单一真源」与「entitlement 不改契约切换」。

因此 P0 必须一次性把 **数据源端口（hexagonal port）与 canonical 内部模型** 定死：适配层负责 tushare→canonical 的翻译，领域/契约只认 canonical；来源、时效、复权口径、授权都通过契约的 `meta` 暴露，而不是泄漏到 schema 字段名里。

## 决策

### D1 端口定义（A1 实现，A11 验证）

端口以 Python `Protocol` 表达（数据侧 Python，决策 #3）；适配器（tushare）是端口唯一实现，位于 `services/ingest/adapters/tushare/`。
端口**只返回 canonical 记录或 None**，不返回 tushare 原始结构；**不返回 entitlement**（授权由 Config Service 在读侧注入，见 C16）。

```python
# services/ingest/ports.py（A1 owns；签名变更须 A0 评审 + H2/H4 按跨域模型变更门禁）
class MarketDataSource(Protocol):
    def get_instrument(self, instrument_id: str) -> InstrumentRecord | None: ...
    def list_instruments(self, exchange: ExchangeCode, as_of: date) -> list[InstrumentRecord]: ...
    def get_quote(self, instrument_id: str, trade_date: date | None = None) -> QuoteRecord | None: ...
    def list_bars(self, instrument_id: str, start: date, end: date,
                  adjustment: AdjType) -> list[BarRecord]: ...
    # L5：adj_factors 是一等方法（非可选）。每根 bar 必须有因子是硬校验（STRUCT-06），
    # 可选方法必然漂移成两套实现。
    def get_adj_factors(self, instrument_id: str, start: date, end: date) -> list[AdjFactorRecord]: ...
    def get_fundamental_summary(self, instrument_id: str) -> FundamentalRecord | None: ...
    def health(self) -> SourceHealth: ...
```

端口错误分类（适配层内部，禁止把 tushare 异常直接穿透到 API）：
- `None` = 无该记录（未收录、无快照或无财报，端口不区分「标识不存在」与「标识存在但资源无数据」）。
  API 层映射 404 时按上下文区分（shared 0.2.1，ADR-001 D4）：`get_instrument` 为 `None` → `INSTRUMENT_NOT_FOUND`；`get_quote`/`list_bars`/`get_fundamental_summary` 无数据时，先确认标识是否存在 —— 标识存在 → `NOT_FOUND`（资源无数据），标识不存在 → `INSTRUMENT_NOT_FOUND`。**判定顺序（Lead m00443）**：① 先存在性（未收录 → 404 `INSTRUMENT_NOT_FOUND`）→ ② 再 entitlement（确认存在但无权展示 → `403 ENTITLEMENT_RESTRICTED`）→ ③ 最后取数（存在且有权但无数据 → 404 `NOT_FOUND`）。未收录标的不得用 403 掩盖 404；存在性属公开信息，藏它只增加支持成本。
- `InvalidRequestError` = 参数非法（API 映射 400 `VALIDATION_ERROR`）。
- `SourceUnavailableError` = 源不可用/超时/限流（API 走降级，见 C17；不返回 5xx，除非无快照）。
- `SchemaDriftError` = tushare 字段/类型变化（告警 A13 + 拒绝入库，**不得猜测补齐**）。
- 适配层重试必须幂等，带超时与退避；重试策略属 A1，但不得改变端口语义。

### D2 canonical 内部模型（唯一允许跨层传递的数据结构）

字段名 snake_case，与契约共享 schema 同名；金额 `Decimal`（禁止 float 累计误差），存储层按 `numeric` 落库。

```text
SourceRef      { source: str, as_of: datetime(+08:00), fetched_at: datetime(+08:00) }
               # source 取值：tushare | snapshot | platform；换源只换取值，不改结构。
InstrumentRecord {
  instrument_id: str(EXCH:CODE), exchange: SSE|SZSE|BSE, code: str(6位),
  name: str, board: main|gem|star|bse, security_type: stock|etf|index,
  list_status: listed|delisted|pre_listed, lot_size: int, listed_at: date|None,
  source: SourceRef }
QuoteRecord {
  instrument_id: str, trade_date: date,
  last_price|prev_close|change|change_pct|open|high|low: Decimal|None,
  volume: int|None, amount: Decimal|None,
  suspended: bool, limit_status: none|limit_up|limit_down,
  source: SourceRef }
BarRecord {
  instrument_id: str, trade_date: date,
  open|high|low|close: Decimal, volume: int, amount: Decimal,
  adjustment: AdjType, source: SourceRef }
FundamentalRecord {
  instrument_id: str, report_period: str(YYYYQn), report_end_date: date,
  announced_at: datetime(+08:00), statement_basis: reported|restated,
  currency: CNY, revenue: Decimal, net_profit: Decimal,
  revenue_yoy_pct|net_profit_yoy_pct|eps|roe_pct|gross_margin_pct|total_assets: Decimal|None,
  source: SourceRef }
AdjFactorRecord {
  instrument_id: str, trade_date: date, factor: Decimal,  # 归一后累计因子（见下）
  factor_raw: Decimal,                                    # 源原始因子，审计留痕
  source: SourceRef }
```

- 复权因子归一（decisions.md L3，**待 H4 会签**）：`adj_factor.v1 = 原始因子 / 锚因子`，锚 = 该标的**最早可得因子日**；1990-12-19 前上市的老股锚定 1990-12-19 并在文档标注。M02 收益在两种锚下等价，但 hfq 绝对价不同 —— 属口径变更，H4 签字前不得用于对外 hfq 展示。

- 内部**只存 EXCH:CODE**；「代码.交易所后缀」等 tushare 代码格式只允许出现在适配器内部转换函数中，落库/日志/配置/测试夹具一律禁止（C01；原始层豁免边界见 D2a）。
- `fetched_at` 是采集时间，仅内部审计用；契约 `meta.source.as_of` 用市场时点，禁止混用（C04）。
- 复权：DWD 存**不复权 OHLC + 每股复权因子表 `adj_factor(instrument_id, trade_date, factor, factor_raw)`**；`qfq/hfq` 在满足口径要求时按因子确定性计算，并回显 `adjustment`。不存三份 OHLC，避免口径漂移。每根 bar 必须有因子（STRUCT-06，L5 一等方法 `get_adj_factors`）。
- 财报保留 `reported` 与 `restated` 两套记录（H4 D6），查询时按确定规则选取并回显 `statement_basis`（C12）。

### D2a C01 豁免边界（仅原始层）

C01 是**单向**约束：源格式只允许存在于「接收源数据的最外沿」，越过该层必须已转换为 `EXCH:CODE`。豁免是最小集合，且只是路径级/列级豁免，不放宽 canonical 数据的 C01 断言：

| 豁免路径 | 允许内容 | 必须仍满足的边界 |
|---|---|---|
| `services/ingest/src/market_ingest/adapters/tushare/**`（A1 实际布局；Lead 原始清单写的 `services/ingest/adapters/**` 同一意图，若后续调整目录以实际路径为准） | 适配器内部转换函数可读取 `ts_code`、可暂存源格式字符串 | 端口返回值、日志、写入 DWD 的记录必须已是 `EXCH:CODE`；源格式不得逸出转换函数 |
| `warehouse/ods/**` | **仅 `raw` JSONB 列**可原样保存 tushare payload（可含 `ts_code`） | 表主键/业务列/分区键/审计列不得存源格式；ODS 不得对外查询（D3），仅审计/重放 |
| `tests/fixtures/tushare/**` | 录制的 tushare 原始响应 | 仅作回放输入，不得被 DWD 清洗逻辑直接引用 |
| `tests/e2e/tushare-replay/recordings/**` | e2e 回放磁带 | 仅 A12 回放使用，不得进入生产镜像/生产配置 |

### D2b C01b 厂商标识门禁（提交脚本，ADR-004）

D2a 是「源格式」边界（`ts_code`/点号代码），D2b 是「厂商标识」边界。二者互补，不能用一个模糊的 grep 代替：

- **脚本**：`infra/ci/check-source-vocabulary.mjs`，随代码提交，不是聊天里跑过一次的命令。
- **扫描面**：`contracts/**/*.yaml`（含 `description`/`examples`，对外契约会被外部消费者读到）与 `packages/api-client/src/generated/**/*.ts`（生成产物会进前端）。
- **规则**：按厂商标识词表整词匹配（当前 `tushare`/`wind`/`choice`/`ifind`/`akshare`/`eastmoney`），命中即红灯；同时断言 `SourceRef.source` 是显式有限枚举且成员均为 `platform_*`。
- **明确排除**：`docs/adr/**`、内部文档、实现代码、测试夹具——它们必须能讨论「为什么不能用某厂商」。**范围划清楚比匹配写严密更重要**，否则团队会用 `t-u-s-h-a-r-e` 绕过。
- **CI 挂载**：`.github/workflows/ci.yml` 的 contracts job 在 `pnpm run ci:contracts` 之后执行该脚本（A13 维护 workflow；A0 提供脚本与自测）。
- **自测**：`node infra/ci/check-source-vocabulary.mjs --self-test` 必须能命中样例；脚本自身失败（找不到契约、enum 解析失败）按红灯处理，不静默通过。
- **增删词表**：A0 提案 + H2 签字（新增豁免/供应商同样走该流程）。

以下位置出现源格式或 `ts_code` 一律红灯（CI 阻断）：`warehouse/dwd/**`、`warehouse/dws/**`、serving 快照、`contracts/**`、`services/{api,market,content,identity,compliance,crm}/**`、`web/**`、`packages/api-client/**`、`tests/data/**`（golden）、日志/配置/告警/看板。`docs/adr/**` 只以文字/正则描述规则、不承载数据，故在守卫中排除。

**可执行守卫命令**（A11 落成 `tests/contract/test_c01_source_format.py`，A13 接入 CI；A0 只定义断言与命令语义，不写实现）：

```bash
# G1 数据承载面正向扫描（CI 阻断）：只扫「canonical 数据必须成立」的路径。
#     理由：文档/测试宿主不承载 canonical 数据；适配器测试属于原始层，随适配器豁免；
#     DB/DWD/Serving 的 canonical 列由 A11 SQL 断言兜底，不靠文本扫描。
python3 - <<'PYEOF'
import pathlib, re, sys

ROOT = pathlib.Path('.')
PATTERN = re.compile(r'\bts_' r'code\b|\b\d{6}\.(?:SH|SZ|BJ)\b')
IGNORE_DIRS = {'node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'}
RAW_LAYER = ('services/ingest/src/market_ingest/adapters/tushare/',
             'warehouse/ods/')
EXEMPT_TREES = ('docs/', 'agents/', 'tests/contract/', 'tests/e2e/',
                'tests/fixtures/', 'services/ingest/tests/', 'warehouse/tests/')
SCOPES = (
    'contracts/**/*.yaml',
    'packages/api-client/src/generated/**/*.ts',
    'packages/design-tokens/**/*',
    'tests/data/**/*',
    'warehouse/**/*.py', 'warehouse/**/*.sql', 'warehouse/**/*.json',
    'warehouse/**/*.yaml',
    'web/**/*.ts', 'web/**/*.tsx', 'web/**/*.js', 'web/**/*.json',
    'services/**/*.py', 'services/**/*.ts', 'services/**/*.yaml',
    'services/**/*.json',
)

def excluded(rel: str) -> bool:
    if any(rel.startswith(prefix) for prefix in RAW_LAYER + EXEMPT_TREES):
        return True
    return '/tests/' in rel or rel.endswith('.md')

files = set()
for pattern in SCOPES:
    files.update(path for path in ROOT.glob(pattern) if path.is_file())

violations = []
for path in sorted(files):
    rel = path.relative_to(ROOT).as_posix()
    if excluded(rel) or any(part in IGNORE_DIRS for part in path.parts):
        continue
    text = path.read_text(encoding='utf-8', errors='ignore')
    for match in PATTERN.finditer(text):
        line = text.count(chr(10), 0, match.start()) + 1
        violations.append(f'{rel}:{line}: {match.group(0)}')

if violations:
    print('C01 violation: tushare raw identifier leaked into canonical layer', file=sys.stderr)
    print('\n'.join(violations), file=sys.stderr)
    sys.exit(1)
PYEOF
```

**范围判定依据（2026-11-04 实测）**：该清单扫描 245 个文件、0 命中；而「全仓除 4 豁免路径」的严格扫描会命中 109 处，全部落在 `docs/*.md`、`tests/**`（含 e2e 回放宿主/契约测试注释）、`warehouse/tests/`、`services/ingest/tests/`，以及按 Lead 原始清单未覆盖、但实际承载 `ts_code` 的适配器真实路径 `services/ingest/src/market_ingest/adapters/tushare/**`。因此 ADR 按「数据承载面」收窄，并把实际适配器路径补入豁免；这不是放宽豁免，而是把「原始层/文档/测试宿主」与「canonical 数据面」区分开。新增豁免路径仍须 A0 提案 + H2 书面签字。

```bash
# G2 对外层正向校验：contracts/ + generated 客户端 + golden fixtures 不得含源格式；
#    同时 A11 须用 SQL 断言 DWD/serving 的 instrument_id 全部匹配 ^(SSE|SZSE|BSE):[0-9]{6}$。
python3 - <<'PY'
import pathlib, re, sys
bad = re.compile(r'\b\d{6}\.(SH|SZ|BJ)\b|\bts_' r'code\b')
targets = [*pathlib.Path('.').glob('contracts/**/*.yaml'),
           *pathlib.Path('.').glob('packages/api-client/src/generated/*.ts'),
           *pathlib.Path('.').glob('tests/data/**/*.json')]
fails = [f'{p}: {m.group(0)}' for p in targets if p.is_file()
         for m in bad.finditer(p.read_text(errors='ignore'))]
if fails:
    print('\n'.join(fails), file=sys.stderr)
    sys.exit(1)
PY
```

守卫脚本自身若位于被扫描目录内（如 `tests/contract/`），必须自排除或动态拼接关键字，避免自命中导致假红灯；A13 在 CI 中可改用 ripgrep，但**必须显式区分「无匹配(1)」与「工具错误(127)」**，工具缺失不得视为通过。

- 换源时只替换适配器与 ODS 原始列，DWD 及以上不受影响；豁免不是「以后可以放宽」，新增豁免路径须 A0 提案 + H2 书面签字。

### D3 分层与数据流

```
tushare（原始） → ODS（raw payload + fetched_at + source，可追溯）
                → DWD（canonical 记录，去重/校验/口径归一，主键幂等 upsert）
                → DWS/serving（quote 最新快照、bars、fundamental 最新一期；供 API 低延迟读）
API 服务（A3）：读 serving → 叠加 entitlement（Config Service）+ disclaimer（A5）→ 产出契约响应
```

- 采集频率（C2=A）：收盘后采集当日数据，SLO 收盘后 ≤15 分钟可查；不做盘中实时推送。
- ODS 保留原始 payload 与采集元数据（`source`/`as_of`/`fetched_at`/批次 id），仅供审计与重放；**不得直连对外 API**。
- serving 快照只保留「最近一次成功」，降级时作为 `source=snapshot` 数据源（C17）。

### D4 来源/时效/复权的契约映射

| 契约字段 | 来源 | 规则 |
|---|---|---|
| `meta.source.source` | 适配层 | `tushare`（正常）、`snapshot`（降级）、`platform`（平台自有，如自选） |
| `meta.source.as_of` | 适配层按数据市场时点计算 | 收盘快照 = 当日 `15:00:00+08:00`；财务 = 公告 `announced_at` 之后的数据时点 |
| `meta.source.staleness_ms` | **API 响应时计算** | `max(0, now − as_of)`，适配层不得预置；>900000 时 H5 必须标 stale |
| `meta.entitlement` | Config Service 读侧注入 | 适配层不产出；切换 tier 不改契约、不改库 |
| `meta.adjustment` | 请求/读侧计算 | 缺省 `none`；响应回显生效值，且 `meta.adjustment == data.adjustment` |
| `meta.disclaimer` | A5 规则版本（H3 立法） | 文案+版本号；`closable` 恒 false |

### D5 质量与可重放

- 每次采集产出批次记录（批次 id、时间、行数、拒绝行数）；拒绝行必须落 DLQ 并有告警，不得静默丢弃。
- A2 的 `quality/` 对 DWD 跑数据质量规则（主键唯一、OHLC 关系 high≥max(open,close)≥min(open,close)≥low、volume≥0、交易日历覆盖、复权因子非零）。
- A11 的契约测试使用 golden fixtures（`tests/data/`）与 mock 端口，不依赖实时 tushare；A12 e2e 用 `source=snapshot` 的固定快照。

## 20 条 conformance（C01–C20）

A11 必须逐条写成可执行测试（`tests/contract/`），A1 实现需全部通过；A13 在 CI 中作为合并门禁。A0 只定义断言，不写实现。

| # | 断言 | 责任 |
|---|---|---|
| C01 | `instrument_id` 全部匹配 `^(SSE|SZSE|BSE):[0-9]{6}$`；落库/日志/夹具中无「代码.交易所后缀」类格式（豁免边界仅限 D2a 的 4 个原始层路径，DWD 及以上不豁免；守卫命令见 D2a G1/G2）。C01b：对外契约/生成产物无厂商标识、`source` 为平台词表（D2b，脚本 `infra/ci/check-source-vocabulary.mjs`） | A1/A11/A0 |
| C02 | `exchange`/`board` 取值合法且组合一致（SSE→main/star，SZSE→main/gem，BSE→bse）；未知组合拒绝并告警 | A1/A11 |
| C03 | 每条 canonical 记录携带非空 `source.source`，且符合 shared SourceRef pattern；空来源入库即失败 | A1/A11 |
| C04 | `as_of` 是 +08:00 的市场时点，不等于 `fetched_at`；两者都不得缺失 | A1/A11 |
| C05 | `staleness_ms` 在 API 响应时计算、`≥0`，且与 `now − as_of` 一致（容差 1s）；>900000 时响应可被标记 stale | A3/A11 |
| C06 | `adjustment` 仅接受 `none/qfq/hfq`；缺省 `none`；非法值 → 400 `VALIDATION_ERROR`；响应回显生效值 | A3/A11 |
| C07 | 同 `(instrument_id, trade_date, adjustment)` 的 bar 计算确定；`none` 序列不因除权而回溯变化，`qfq` 变化必须伴随 `as_of` 更新 | A1/A11 |
| C08 | 非交易日/停牌日不生成 bar；`from`/`to` 含端点；不出现周末/节假日行；不补 0 | A1/A11 |
| C09 | `volume` 单位为股（int），`amount` 单位为元；无「手/万元」量纲泄漏 | A1/A11 |
| C10 | 缺失价格用 `null` 而非 0；`suspended=true` 时 `last_price` 可为 null；禁止伪造数值 | A1/A11 |
| C11 | `limit_status` 按板块规则判定（主板 10%、创业板/科创板 20%、北交所 30%、ST 5%，以 H4 规则版本为准），不得硬编码 10% | A1/A2/A11 |
| C12 | 财报 `reported` 与 `restated` 两套记录都保留；响应必须回显 `statement_basis`，选期规则确定（按 `announced_at`） | A1/A2/A11 |
| C13 | `report_period` 匹配 `^\d{4}Q[1-4]$`；`report_end_date` 为对应季末；`announced_at ≥ report_end_date` | A1/A11 |
| C14 | 退市证券保留（`list_status=delisted`）不删除；历史 quote/bars 仍可查；`pre_listed` 不返回 quote | A1/A11 |
| C15 | 重复采集同一自然键（如 `instrument_id+trade_date`）幂等 upsert，不产生重复行；批次重放结果一致 | A1/A11 |
| C16 | 适配层输出不含 `entitlement`；`meta.entitlement` 由 Config Service 读侧注入；切换 tier 不改变存储数据与契约结构 | A3/A4/A11 |
| C17 | 源不可用时返回最近成功快照（`source=snapshot`、`as_of`=快照时点、`staleness_ms` 按响应计算）；无快照才 5xx；禁止空数据/伪造数据 | A1/A3/A11 |
| C18 | 所有日期按 Asia/Shanghai；日线 `trade_date` 为交易日；收盘快照 `as_of=15:00:00+08:00`；无 UTC 日期泄漏 | A1/A3/A11 |
| C19 | canonical/ODS/日志/配置中无 tushare token 或密钥；原始 payload 访问受控（A9/A13），审计可追溯 | A1/A9/A11 |
| C20 | canonical→契约的映射覆盖契约所有 required 字段（含四要素 source/as_of/adjustment/entitlement，按 D4 规则），并通过 shared schema 校验；A11 20/20、A12 至少一条全链路 e2e | A3/A11/A12 |

## 被否选项及原因

| 选项 | 否决原因 |
|---|---|
| 业务/API 直接查询 tushare 接口 | 换源需改所有消费方；限流与授权无法集中控制；违反决策 #4 |
| canonical 模型直接复用 tushare 字段名与代码格式 | 泄漏源细节（交易所后缀点号格式、`ts_code`），换源即契约破坏 |
| 存三份 OHLC（none/qfq/hfq） | 数据膨胀、口径漂移、除权回溯时三份不同步；改为存不复权 + 因子 |
| 适配层返回 entitlement | 授权是运营配置（A14/A15）且 F1 未定，必须读侧注入才能「不改契约切换」 |
| `staleness_ms` 在采集时写入 | 时效随响应时刻变化，入库即过期；必须响应时计算 |
| 适配层把 tushare 异常翻译成业务错误码 | 适配层无权定义契约错误语义；按端口错误分类上抛，由 API 映射 |
| 为 P0 引入消息队列/Kafka 做实时 | C2 已裁定不做盘中实时；收盘后批处理足够，避免过度设计 |

## 可逆性评估

- **端口可逆性高**：换数据源只需新增适配器实现（C01–C20 即验收标准），domain/serving/契约不动。
- **canonical 模型可逆性中**：字段新增为 additive（minor）；删改字段属跨域数据模型变更，须 H2/H4 会签并同步 A11/A12 夹具。
- **复权存储方案可逆性中**：改存多份口径可回滚，但需重跑历史；当前「不复权 + 因子」在换源时最稳。
- **降级语义可逆性低**：一旦 C17 被前端/测试依赖，改变「快照 + 显式 stale」行为会影响 H5 展示与合规口径，须 H5/H3 评审。

## 待定项

- F1 tushare C 端商用授权（7 日内 H4 决策）：只影响 `Entitlement.tier` 取值与可展示范围，**不影响端口与 canonical 结构**。
- 复权因子来源（tushare `adj_factor` 接口）与更新频率：A1 在实现时确认，纳入 C07/C11 测试；若源不提供，需 H4 裁决替代口径（升级项）。
- 退市/更名历史的事件表（P1）：`InstrumentRecord` 目前只有当前状态，历史状态追溯属 P1 扩展，新增字段必须 optional。
