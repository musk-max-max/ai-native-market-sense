# A11 门禁 CI 挂载口径（task-4 交付）

> 归口：A11（tests/contract/、tests/data/）；挂载：A13（.github/workflows/）。
> 本文件是 A11 与 A13 的接口合同：命令、退出码含义、触发时机、红灯归属。
> 改动本文件需 A11 评审；改动被锁定的阈值/权重需 H4 签字（见 §4）。

## 1. 门禁清单（一个 job 两条命令，全绿才算过）

| ID | 命令 | 证明什么 | 红灯归属 |
|----|------|----------|----------|
| G-CONTRACT | `python3 -m pytest tests/contract -q` | 契约结构合规 + 破坏性 diff 已声明 + provider/consumer 双向符合契约 + 门禁自证 | A0（契约）/ A11（测试宿主）/ H2（waiver） |
| G-DATA | `python3 -m pytest tests/data -q` | 质量分 L9 口径与已批准配置一致 + golden 30 条回归 + 13 条规则单测 + 坏数据注入必红 | A2（数据/管线）/ H4（期望口径）/ A11（参考实现） |
| G-IMPL | `python3 -m tests.contract.live_impl_check --base-url $A11_IMPL_BASE_URL` | **真实实现**逐 consumer 调用校验契约（状态/schema/Problem/时区/授权降级/字段泄漏） | A3（API/域路由）/ A7（实现）/ A11（校验器） |

错误码集合：P0 共 8 个（ADR-001 D4，shared 0.1.2 起新增 `NOT_FOUND`）。`INSTRUMENT_NOT_FOUND`=标识不存在/未收录；
`NOT_FOUND`=标识存在但资源无数据（无快照/无财报）或路由不存在。**判定顺序（Lead m00443，2026-11-04 修订，"
shared 0.2.1）**：先存在性（未收录 → 404 `INSTRUMENT_NOT_FOUND`）→ 再授权（确认存在但无权展示 → 403
`ENTITLEMENT_RESTRICTED`）→ 最后取数（存在且有权但无数据 → 404 `NOT_FOUND`）；未收录标的不得用 403 掩盖 404。
A11 侧由 `test_provider_contract.py` 的双 404 语义样本 + `live_impl_check` LIVE-04/LIVE-10 覆盖，"
验收脚本 `tests/data/acceptance/check_entitlement_killswitch.py` 另有受限档下「未知标的必须 404 而非 403」的实跑断言。
新增错误码属 D5 非破坏变更，
必须 ADR + `P0_ERROR_CODES` 同步（只改一边 `test_error_code_set_is_frozen` 会红）。

拆开看，G-CONTRACT 覆盖：

- `test_contract_lint.py`：OpenAPI 3.1 结构、命名、成功包络、meta 单一真源、错误码/状态码、security、无循环 $ref、无未使用组件（ADR-001 D2–D8）。
- `test_contract_diff.py`：以 `tests/contract/baselines/v1/` 的冻结快照为基线跑
  `oasdiff breaking --fail-on ERR --severity-levels contracts/oasdiff-severity.txt`；破坏性变更未登记 waiver 即红；
  baseline 被改（sha256 不符）即红；oasdiff 版本漂移即红。**H2 L45**：`response-optional-property-removed`
  默认 severity=info，必须由 severity 配置文件提升为 err，否则「删除 optional 字段」对门禁不可见；
  配置只能有 H2 审过的两行（多一行即红，`test_severity_policy_is_approved_and_not_widened`），
  四域基线只允许 market 的 lot_size 那 1 条 ERR（`test_four_domain_baseline_has_only_declared_error`）。
- `test_provider_contract.py`：录播样本逐状态码校验响应体符合契约；语义断言（+08:00、adjustment 回显、无权限不得泄漏行情、404 的 INSTRUMENT_NOT_FOUND / NOT_FOUND 两种语义必须区分）。
- `test_consumer_contract.py`：H5 期望的字段/状态码必须被契约支持；请求必须合法；禁止依赖内部字段（fetched_at 等）。
- `test_gate_selfcheck.py`：在 tmp 副本里故意把 `volume` 改成 string，oasdiff 必须红；注入 camelCase 字段，lint 必须红；新增可选字段不得误报；**删 optional request property 不得被抬成 ERR**（负样本，防 severity 配置写宽）。`_run_cli()` 已固定 `cwd=仓库根`，从 `services/ingest` 等子目录跑也一致。**证明门禁不是空转。**
- `test_impl_gate_selfcheck.py`：本地 stub 服务返回录播样本，注入 volume 类型漂移/缺 meta.source/fetched_at 泄漏/adjustment 回显不一致/未声明状态码/Content-Type 错误/Problem.code 非法/未授权泄漏行情/consumer 依赖字段缺失/服务不可达 → 每项必须被对应的 LIVE-* 规则抓住，干净 stub 必须零误报。**证明 G-IMPL 第一次跑就能抓住实现问题。**
- `live_impl_check.py`：G-IMPL 的校验器本体（CLI 入口，退出码 0/1/2），只连本地被测服务，禁止连真实 tushare。

G-DATA 覆盖：

- `test_quality_config.py`：`warehouse/quality/quality_config.json` 必须与 `tests/data/quality_policy.yaml`（H4 已批准：权重 0.2/0.3/0.3/0.2，阈值 95/90/85，blocker 一票否决，板块幅度，13 条规则 severity）逐项一致。
- `test_golden_dataset.py`：`data/golden/p0_bars20.yaml` 的 30 条 case（21 正例 + 9 负例，含 A2 2026-11-04 补的 G21「ST 恰好 +5.00%」）逐条 grade/blocked/violations 回归；边界类覆盖；涨跌停分位舍入；复权数字可由 close×factor 推出。
- `test_quality_rules_unit.py`：13 条规则每条单独触发一次，防「规则在册但从未执行」。
- `test_bad_data_injection.py`：注入结构/业务/完整性坏数据 → 子进程 pytest 必须非零；未注入必须零。**证明门禁能红也能绿。**

## 2. 触发时机（A13 按此配 workflow，建议 required checks）

- `pull_request`：全量跑，必须 required（阻塞合并）。
- `push` 到 `main`：全量跑（防绕过 PR 直推）。
- `schedule`（每日 UTC 18:00 ≈ 北京 02:00）：全量跑，捕获工具链/上游数据漂移。
- 路径过滤（省时间，不省门禁）：`contracts/**`、`tests/contract/**`、`tests/data/**`、`data/golden/**`、`warehouse/quality/**`、`docs/metrics/**`、`docs/adr/**`、`.github/workflows/**`。

- G-IMPL 额外触发：`pull_request` 且改动命中 `services/api/**`、`services/market/**`、`packages/**`、`contracts/**` 时，由 task-2 的 job 先起 A12 的 docker-compose 真栈（录播 fixture，不连 tushare），注入 `A11_IMPL_BASE_URL`（以及测试用 `A11_IMPL_TOKEN`）后跑；`schedule` 每日也跑一次，抓「实现悄悄漂移」。
- G-IMPL 缺环境变量时退出码 2（红灯），**不允许 skip**：门禁没接上=没做完，不是通过。
- 真栈复用 A12 的 `tests/e2e/docker-compose.yml`（api 端口默认 8081，`E2E_API_PORT` 可覆盖）；它与 A12 的 e2e 共用同一套录播 fixture，CI 结构上禁止出网。

建议 workflow 骨架（A13 落盘时照抄命令，不用照抄结构）：

```yaml
jobs:
  contract-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install "pytest==7.4.4" "PyYAML==6.0.2" "jsonschema==4.23.0" "rfc3339-validator"
      - name: oasdiff 1.35.0（版本锁定，禁止 latest）
        run: |
          curl -fsSL -o oasdiff.tgz https://github.com/oasdiff/oasdiff/releases/download/v1.35.0/oasdiff_1.35.0_linux_amd64.tar.gz
          tar xzf oasdiff.tgz oasdiff && sudo install -m 0755 oasdiff /usr/local/bin/oasdiff
          test "$(oasdiff --version)" = "oasdiff version 1.35.0"
      - run: python -m pytest tests/contract -q
  data-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install "pytest==7.4.4" "PyYAML==6.0.2" "jsonschema==4.23.0" "rfc3339-validator"
      - run: python -m pytest tests/data -q
  impl-gate:
    runs-on: ubuntu-latest
    needs: [contract-gate]   # 契约本身先过，再验实现
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install "pytest==7.4.4" "PyYAML==6.0.2" "jsonschema==4.23.0" "rfc3339-validator"
      - name: 起真栈（A12 的 tests/e2e/docker-compose.yml，录播 fixture；禁止真实 tushare）
        run: |
          docker compose -f tests/e2e/docker-compose.yml up -d --wait
          python3 tests/e2e/scripts/preflight.py   # A12 的交接检查；SKIP(78)/FAIL(1) 在 G-IMPL 里都按失败处理
      - run: python3 -m tests.contract.live_impl_check --base-url "http://127.0.0.1:${E2E_API_PORT:-8081}"
        env:
          A11_IMPL_TOKEN: ${{ secrets.E2E_A11_TEST_TOKEN }}   # 未配置则 watchlist 调用 401 → 红灯（不 skip）
```

绿灯口径：两条命令 exit 0，且输出中没有 `skipped`（本套测试刻意不设 skip，skip 视为失败；见 §3）。

## 3. 红灯判定与纪律

- **任一 pytest 非零退出 = 红灯**；`warnings` 必须出现在 PR 检查日志里（当前 0 warning）。
- 测试必须确定性：不得依赖当前时间、网络、随机数、真实 tushare 接口、真实行情。CI 里 `tests/contract/specimens/` 的 `origin` 只允许 `synthetic` / `replay`。
- 禁止的「变绿」手段（A11 一票否决）：改断言/改期望/删用例/加 skip/xfail/放宽阈值/增大容差/手动更新基线快照而不更新 manifest。
- 红灯先判定归属，再改代码：
  1. 契约与实现不一致无法判定归属 → 报 A0 + H2；
  2. 数据包/管线错 → A2；
  3. golden 期望错 → H4 签字后 A2 改；
  4. 测试宿主（fixture/参考实现）错 → A11 改测试，PR 里必须写清「哪条断言基于哪条 ADR/决策」。
- 门禁自证失败（`test_gate_selfcheck` / `test_impl_gate_selfcheck` / `test_bad_data_injection` 红）优先级最高：说明门禁本身失效，先修门禁。
- G-IMPL 的 `LIVE-00`（连不上被测服务）同样是红灯：CI 里要么把服务起好，要么这个 job 算没接完；不允许以 `skip` 掩盖。

## 4. 例外流程（唯一合法绕行通道）

1. 契约破坏性变更：在 `tests/contract/waivers.yaml` 登记 `id / finding / reason / adr / approved_by / expires_at`，`approved_by` 必须是 H2，`expires_at` 必须填且到期即红；无效 waiver（对应 find 不再出现）也红。
2. 已知契约缺陷：`tests/contract/known_defects.yaml`（TTL 上限 14 天，过期即红；条目失效先告警、到期仍驻留则红）。当前为空：KD-001/002/003（shared 响应组件未被引用）已于 2026-11-04 由 A0 修复并闭合（L10）——market quote/bars、fundamental 补 `403 EntitlementRestricted`，watchlist 三接口补 `403 Forbidden`，全部 operation 补 `default: ProblemResponse`；A11 已补 403 录播样本并清空台账。
3. 口径争议：`tests/data/quality_policy.yaml` 的 `open_questions`（当前 Q-WARN-SCORE 已由 L9 裁定、待 H4 会签：只由 blocker 计分，类别分 = 1 − 命中 blocker 的不同规则数 / 该类规则总数，warn 只作展示）。A2 已于 2026-11-04 同步 `warehouse/quality/checks.py`（按规则去重、warn 不进分子但计入分母规则数）与 `docs/metrics/P0-metrics.md §6`，`pytest warehouse/tests` 55 passed、golden 30/30；H4 会签文本已按规则数分母版本改写，签字前以会签栏为准。未会签前仍以 quality_policy.yaml 的 `score_counts: blocker_rules` 为准，不允许代码里另立口径。
4. 任何要求「这次先放过门禁」的诉求 → 升级 H2；A11 不绕过自己的门禁，也不接受口头豁免。

## 5. CI 环境约束（硬）

- **禁止真实 tushare 接口进 CI**：测试只读仓库内 fixture/录播；出现 tushare 域名或 token 即红（`test_specimen_format_is_safe_and_offline` 已断言）。G-IMPL 只连本地被测服务（其数据来自录播 fixture），不是打 tushare。
- oasdiff 版本锁定 1.35.0（工具链属 H2 冻结清单）；版本不匹配直接失败，不 skip。
- 契约基线 `tests/contract/baselines/v1/` 由 A0 冻结、H2 批准；改基线 = 改门禁，必须新 ADR + H2 签字 + 更新 `baseline_manifest.json` 的 sha256。
- 新增/修改 fixture：`tests/contract/specimens/` 由 A11 维护；`tests/fixtures/` 归 A12；`data/golden/` 归 A2。跨域引用只读，不改别人的文件。

## 6. 本地一键复现

```bash
python3 -m pytest tests/contract tests/data -q
```

当前状态（2026-11-04，契约 market 0.3.0（去 lot_size）+ shared 0.1.2 + H2 L45 severity 门禁后复验）：contract **54 passed**（G-IMPL 自证 14、契约 diff 5、结构/双向/词表等）；data **82 passed**；合计 **136 passed / 0 failed**；1 warning 为 lot_size 删除的已声明 waiver（W-2026-11-04-lot-size-d5，H2 签字，2026-12-15 到期）。oasdiff 四域基线（带 severity 配置）：market 1 ERR + 9 WARN、shared 0、fundamental 3 WARN、watchlist 6 WARN。
G-IMPL 本体现在对 stub 自证通过；对真实实现的首跑等 A3/A7 服务与 task-2 的 job 就绪。
契约版本：market 0.3.0、fundamental 0.2.0、watchlist 0.2.0、shared 0.1.2；相对 `baselines/v1` 的改动为新增 403/default、shared 来源词表与 NOT_FOUND、删除 lot_size（H2 L45 后由 severity 配置判 ERR，waiver W-2026-11-04-lot-size-d5 覆盖到 2026-12-15，不续期）。

## 7. 11-12 放行验收（release job 专用，不进日常必过集）

口径冻结：lead **L36**（8 条 entitlement + 1 个限流桶），H4 m01055 对齐；两桶都挂 release job，不阻塞日常 CI
（日常仍是 `python3 -m pytest tests/contract tests/data -q` = 136 passed / 1 waiver warning）。脚本放 `tests/data/acceptance/`，直接连被测服务；
退出码一律 0 通过 / 1 失败 / 2 缺配置（**2 按失败处理，不 skip**）。

### 7.1 Entitlement 桶（8 条）

**最终全量复跑（2026-11-04 09:14–09:16）**：`postgresql://ms@127.0.0.1:55432/a13_verify`（A13 按 002 终版 `c118eeb3` 重建、`seed-serving-fixture.sh` 已补 SSE:600519），API 起在 127.0.0.1:18095–18099，12 个验收脚本串跑 **全部 PASS**（结果表见 §7.7）。

| # | 断言 | 命令 | 当前状态（2026-11-04 08:57） |
|---|------|------|------------------------------|
| 1 | 到期 fail-closed（quote/bars/fundamental **分别** 403、无任何判读数值；getInstrument 200、`meta.tier=internal_eval`、`is_entitled=false`；到期启动写**恰好 1 条** `entitlement_expired`、重启幂等） | `A11_IMPL_BASE_URL=… A11_EXPIRY_MODE=expired A11_AUDIT_DSN=… ENTITLEMENT_EXPIRES_AT=… python3 tests/data/acceptance/check_entitlement_expiry.py` | **PASS（真实栈，A3 修复后 2026-11-04 08:58）**：三接口分别 403、getInstrument 200/tier=internal_eval/is_entitled=false；启动拒绝 rc=1 且端口未监听；事件 `exp|c_end_display|2026-10-31T16:00:00.000Z|expires_at_passed` 两次启动后 exact count=1（不同 boot_id，幂等），reason=`expires_at_passed` |
| 2 | 启动拒绝：c_end_display 且无 `ENTITLEMENT_EXPIRES_AT` → 退出码非 0 且健康端口未监听 | 同上 `A11_EXPIRY_MODE=unset`（含启动子进程断言） | **PASS**（真实进程 rc=1，无监听；`MarketConfigError` 文案含「拒绝启动」） |
| 3 | 白名单：data ⊆ 7 字段，出现 price/close/volume/pe/pb/概念板块即红；`lot_size` 出现即红 | `A11_IMPL_BASE_URL=… python3 tests/data/acceptance/check_base_info_whitelist.py` | **PASS**（真实 API，恰 7 字段：instrument_id/exchange/name/board/security_type/list_status/listed_at；lot_size 按 D5 删除，契约 market 0.3.0） |
| 4 | hold/stale/control 不可达 → 403；**所有 `/v1/*` 响应无条件 `Cache-Control: no-store`**；SW/PWA 不缓存、SSR 不烤数值 | `A11_HOLD_MODE=stale|hold|unreachable … python3 tests/data/acceptance/check_entitlement_hold.py`；`python3 tests/data/acceptance/check_no_store_all.py` | **PASS（真实栈）**：stale（服务日志 `reason=control_stale`）→ 三接口 403；hold=true → 403 且 instrument 200/tier=internal_eval；control 不可达 → 三接口 403、P95=1.9ms（阈值 1500）；no-store 8 调用/7 operation 全 PASS（含 200 与 403，`services/api/src/app.ts:41-45` 外壳无条件加）；跑完已 `seed-entitlement-audit.sh --restore-fresh` |
| 5 | 渲染无占位（0/--/骨架屏、DOM 数值暗示）；四原因对外文案逐字节相同、内部事件原因可区分 | `python3 tests/data/acceptance/check_entitlement_copy.py`（API 文案）；DOM 部分 A12 `tests/e2e` | **PASS 4/4（真实栈）**：expired/unauthorized_config/hold_active/hold_stale 四种 403 的 title+detail 逐字节一致，无原因/渠道/供应商/数字；DOM 待 A12 |
| 6 | 事件可回指 `doc_sha256+locator`（locator 仅 clause_review，H4 m01638）、链 hash 一致、append-only、`event_key` 幂等；**10 类抽样（含 audit_gap）** | `A11_AUDIT_DSN=… python3 tests/data/acceptance/check_entitlement_events.py` | **PASS（真实库 a13_verify，35 条 / 10 类）**：audit_gap/clause_review/deploy/entitlement_expired/entitlement_flip/hold_clear/hold_set/tier_state_observed/tier_switch/unauthorized_config 齐；`verify_entitlement_chain()`=0；双源（DDL 001+002 vs 已批准 10 类/6 reason）= 一致；audit_gap exact-key 恰 5 键、event_key 逐字 `gap|<uid>|<window_start>`；append-only 三触发器、按类型证据字段全过 |
| 7 | 前端无可绕开关；A19 "前端绕过 403" 攻击用例必须失败；TRUST_PROXY 守卫 | `check_frontend_render_gate.py`（静态）；A19 `tests/adversarial/entitlement-bypass/`（动态） | **PARTIAL（H5 签字前）**：静态 PASS（23 文件）；A19 46 项 = 44 BLOCKED / 1 R4≈P2（修复后 PASS）/ 1 INFO；TRUST_PROXY 4/4（A0 修 `services/api/src/config.ts`，A19 同命令/隔离库/新进程复验）。**收口清单（L74）**：①`http-attempts.jsonl` 当前 0 字节、需 A19 重放 100+ 条原始往返（owner A19，截止 2026-11-05 09:00）②五组攻击完整 transcript 入包（owner A19，同上）③公网 ingress `/v1` 外 404（owner A13，需 staging `PUBLIC_BASE_URL`，截止 11-12）④H5 书面签字（owner H5，11-12 前）。缺一项不转 PASS |
| 8 | 裸启动：不设任何 `ENTITLEMENT_*` → 正常起、行情 403、`meta.tier=internal_eval` | `A11_EXPIRY_MODE=bare python3 tests/data/acceptance/check_entitlement_expiry.py` | **PASS（真实栈）**：裸启动成功、quote/bars/fundamental 403、instrument 200/tier=internal_eval |

### 7.2 限流桶（4 条，真实 API 实测）

| # | 断言 | 命令 | 当前状态 |
|---|------|------|----------|
| 1 | 第 61 次 → 429，`Retry-After` 整数 ≥1s | `A11_IMPL_BASE_URL=… python3 tests/data/acceptance/check_rate_limit.py` | **PASS**（quota=60，真实 API） |
| 2 | 429 为 problem+json、`code=RATE_LIMITED` | 同上 | **PASS** |
| 3 | 伪造 `X-Forwarded-For` 不换桶 | 同上 | **PASS**（换 XFF 仍 429） |
| 4 | 429 文案不露内部码/阈值/桶 key | 同上 | **PASS** |

**当前汇总（2026-11-04 09:24，证据包 v3）**：数据侧第 1–6、8 条 **PASS**（#1 expired 事件 exact 1 条+重启幂等；#4 行为层 PASS + 真实网络不可达 residual 归 H5；#6 10 类/41 条、链 verify=0、双源一致、audit_gap 负向 23514）；**#7 PARTIAL（H5 签字前）**，收口清单见 §7.1 行 7；#5 DOM 归 A12。限流桶 4/4 **PASS**；写失败分层 5/5 **PASS**；display_safe 三条 **PASS**；L73 授权开关清单见 §7.8；L74 红队产物索引见 §7.9。日常 136 passed/1 warning。证据包 **v3**（v2 冻结后补 L73/L74）：`…-v3.tar.gz`，sha 见 `SHA256SUMS`。**A11 数据侧：7 PASS + 1 PARTIAL；11-12 是否放行由 H4/H5 决定**。
### 7.4 证据钉版本（2026-11-04 09:18 最终复跑 / 证据包 v2）

**版本锚点**：仓库已有 git（Lead 首提交 `eb10d21`，之后 A13/L 提交继续推进；本表引用时的 HEAD 见下表）。
三层钉版：**commit 锚整棵树 + 关键文件 sha256 锚内容 + 运行时版本**；工作树脏（dirty）时 commit 不足以复现，
以文件 sha256 为准。任何一条不符即不能引用本文结果。

| 锚点 | 值 |
|------|-----|
| 工作区 | `/Users/leiyu/Documents/deepseek-harness/default-workspace`；证据运行时 **HEAD=`359874a`（clean）**，commit 已含全部脚本文本；本文件更新为 docs-only，提交后另记 |
| 首提交（H4 可引用） | `eb10d21`（485 文件，main，无 remote）；A13 本轮 `912d4fb` |
| 契约版本 | market **0.3.0** / shared **0.1.2**（lot_size 已删，waiver W-2026-11-04-lot-size-d5） |
| DDL | `001_audit_entitlement_events.sql` sha256 `c8116e4fa5bb0d88da5cbfb643cdebbcfcec6d24853544425ec59cfa8c5ffd5e`（720 行）；`002_audit_gap.sql` 终版 sha256 `c118eeb3950149564c06f73a04d4e2e5561a6a6201abae101502635c30e999da`（344 行；window_start/window_end + lost_count 按 reason 分支，L70/L71）；`docs/reference/event-payloads.json` sha256 `9ed8b246aaeb26d59b356d8fe89485396dca434c64d7f20310876ab2566500e9` |
| seed | `infra/db/seed-entitlement-audit.sh` `febc9f77a239a9e290ef4b4359d9b42a93b54d18a685cf6ff698b95c04f35168`；`infra/db/seed-serving-fixture.sh` `72692a628e5f68fd47cf0b4fc1bcdb990ca3fad414d9b7e1cb829eaf59d1ac3c` |
| 基线清单 | `tests/contract/baselines/v1/baseline_manifest.json` `0740ea4e1c1cbf0343774c34d2271539928af6e20340e7b73fa69e9ba96d287e` |
| 工具链 | node v23.11.0；Python 3.12.2（pytest 7.4.4）；oasdiff 1.35.0；PostgreSQL 16.15 |
| 数据库 | `postgresql://ms@127.0.0.1:55432/a13_verify`（本机 PG16；35 条 / 10 类；跑完 `seed-entitlement-audit.sh --restore-fresh`，`audit.entitlement_hold.hold=f`） |
| 验收脚本 sha256（全量） | audit_gap `bf399b973ead2187…`；base_info `b68d9c4022168a29…`；display_safe `3b1110919370f464…`；copy `92e82e80fd81fb07…`；events `3257ac8a612cd932…`；expiry `cc35e739ec793d4e…`；hold `b9adadefd6a736af…`；killswitch `0161ec4de4febe38…`；write_failure `51c4b9bcd94d9f0c…`；frontend `efb9895eb49ceec0…`；no_store `6286b83cbff427cb…`；rate_limit `5ac35c9228e2c967…`；probe `28a1c4779b4eef1c…`（完整值见 `sha256sum tests/data/acceptance/*`） |
| 证据包 | **v3**（2026-11-04 09:24，v2 冻结后的增量）：在 v2 基础上补 L73 `env-switch-inventory.md`、L74 `ADVERSARIAL.md`（A19 每件产物 path+sha256+收件时间）与 `http-attempts.jsonl`/REPORT/JSON；v1、v2 均作废。sha256 见同目录 `SHA256SUMS`（tar 内不嵌自身哈希） |
| 日常门禁 | `pytest tests/contract tests/data` → **136 passed, 1 warning**（waiver 提示；2026-11-04 09:16） |

**8+4 复核路径表**（每条 = 命令 → 断言 → 本次结果 → 证据位置）：

| 项 | 脚本 | 关键断言 | 08:58 结果 | 证据 |
|---|------|----------|-----------|------|
| #1 | `tests/data/acceptance/check_entitlement_expiry.py`（`A11_EXPIRY_MODE=expired`） | 三接口分别 403+无判读数值、instrument 200/tier=internal_eval/is_entitled=false、no-store、启动拒绝 rc≠0/无监听（含 prod 缺 `DEPLOYMENT_UID` → MarketConfigError）、事件 exact 1 条 | PASS | 事件 key `exp|c_end_display|2026-10-31T16:00:00.000Z|expires_at_passed`；两次启动后 exact count=1 |
| #2 | `check_base_info_whitelist.py` | data 恰 7 字段、无 F1 数值、lot_size 出现即红 | PASS | 真实 API：instrument_id/exchange/name/board/security_type/list_status/listed_at |
| #3 | `check_entitlement_events.py` | 10 类抽样、reason 6 值、按类型证据字段、locator 仅 clause_review、event_key 幂等、audit_gap exact-key | PASS | 本次库 35 条 10 类；样例见下 |
| #4 | `check_entitlement_hold.py`（stale/hold/unreachable）+ `check_no_store_all.py` | hold/stale/不可达→403；instrument 降级形状；no-store 全 `/v1/*` | PASS | stale 日志 `reason=control_stale`；不可达 P95=1.9ms；no-store 8 调用/7 op |
| #5 | `check_entitlement_copy.py` | 四原因 403 的 title+detail 逐字节一致、无原因/渠道/供应商/数字 | PASS 4/4 | expired / unauthorized_config / hold_active / hold_stale 四实例 |
| #6 | `check_entitlement_events.py` + `check_audit_gap.py` | 双源枚举（DDL 001+002 vs event-payloads.json）、链 verify=0、链序、append-only 触发器、幂等；audit_gap 键名/窗口/负向插入 23514/exact-key | PASS | 35 条、10 类、chain 0；audit_gap 9 条负向全 23514、被拒后行数不变（§7.6） |
| #7 | `check_frontend_render_gate.py` + A19 `tests/adversarial/entitlement-bypass/` | 前端无放行 env、mock 仅 DEV、前端不读 `ENTITLEMENT_*`；动态攻击全 BLOCKED；TRUST_PROXY 宽网段拒启 | **静态 PASS + 动态 PASS（修复后）**；整条待公网 ingress 与 H5 签字 | 23 文件静态扫描；A19 `trustproxy-guard.json` 4/4、`results-r4.json` R4 PASS、`results.json` S/H/C/E/V 组全 PASS |
| #8 | `check_entitlement_expiry.py`（`A11_EXPIRY_MODE=bare`） | 裸启动、行情 403、tier=internal_eval；事件层不适用（仅 expired 模式） | PASS | 真实 API 18089 |
| 限流 1–4 | `check_rate_limit.py` | 第 61 次 429、Retry-After≥1、problem+json、XFF 不换桶、文案不露内部码 | PASS 4/4 | 真实 API 18090 |
| display_safe 1–3 | `check_display_safe_failclosed.py` | tushare 误写 display 拒；删 manifest prod 拒；synthetic 忽略 | PASS | 四场景黑盒 pipeline/load |

**样例行（可直接在 a13_verify 翻）**：
- expired：`event_key = exp|c_end_display|2026-10-31T16:00:00.000Z|expires_at_passed`，`reason=expires_at_passed`，occurred_at 2026-11-04 08:57:40+08。
- clause_review 三条（**TEST(seed)，非真实复核**；真实条款复核待 F1 文本，由 H4/H3 插入）：`clause|83c58c19dee27a46e24a1f9df07c953da538093985bbd0a7e738e863703ef68b|L12.3|2026-11-04`；`clause|375c3c8933ccdd6dd82b55f827df11e74440d4270c1d43c920eb404eea4b02e7|L17.6|2026-11-04`；`clause|3b7cc80153cb5b09cd120bda12c3b50dd4e8430712705e3c30606d7d5b9eca44|L10.3|2026-11-04`（reason 均 `clause_change`）。seed 事件只许进一次性 a13_verify、跑完 drop，trace_id 前缀 `seed:`；报告逐条标「TEST, 非真实复核」。
- 复核 SQL：`select event_type,event_key,reason,occurred_at from audit.entitlement_events where event_type in ('clause_review','entitlement_expired') order by occurred_at desc;`；`select * from audit.verify_entitlement_chain();`（空 = 完整）。

**边界声明（H4 m01841）**：门禁全绿 ≠ 有授权。F1 结论未出前授权档仍为 `internal_eval`、C 端行情仍 403；#7 动态攻击用例（A19）与 #5 DOM（A12）未关之前**不写"8/8 全绿"**，只写「数据侧 7 条 + 限流 4/4 绿，2 项 BLOCKED 不属 A11 责任域」。

### 7.8 L73 授权开关清单（2026-11-04 09:22）

静态扫描 `services/ web/h5/src/ tests/ infra/ warehouse/` 的 `ENTITLEMENT_*` / `*_CHECK` / `*_DISABLE` / `*_BYPASS` / `E2E_MODE` / `DEV_AUTH`。完整表见 `tests/contract/env-switch-inventory.md`。

结论：**唯一能关授权判定的开关是 `ENTITLEMENT_HOLD_CHECK`**；prod（APP_PROFILE 缺省/非 dev|test|e2e）设 `=0` 由 `services/market/src/config.ts:173` 拒绝启动（L73），未发现第二种。`E2E_MODE=1`/`WATCHLIST_DEV_AUTH=1`/`E2E_AUTH_TOKEN` 在 prod 同样拒启（`:163-165`）。`ENTITLEMENT_AUDIT=0` 在 prod 允许——它只关审计证据、不关 403，A11 建议同 HOLD_CHECK 锁死（待 H4 拍板）。`TRUST_PROXY` 只影响 XFF→IP 桶，不改变授权判定。

### 7.7 最终全量复跑记录（2026-11-04 09:14–09:16，a13_verify @ 002 `c118eeb3`）

命令：`/tmp/run_1112.sh`（A11 本地运行，等价命令逐条见 §7.1/§7.2；无 docker，故用本机 API 18095–18099 + 一次性 scratch 库）。

| 序 | 脚本 | 结果 | 备注 |
|---|------|------|------|
| 1 | `check_entitlement_expiry.py`（expired） | PASS | 三接口 403、instrument 200/tier=internal_eval、no-store、启动拒绝 rc=1、expired 事件 exact 1 条 |
| 2 | `check_no_store_all.py` | PASS | 8 调用/7 operation，含 200 与 403 |
| 3 | `check_base_info_whitelist.py` | PASS | 恰 7 字段，lot_size 出现即红 |
| 4 | `check_entitlement_expiry.py`（bare） | PASS | 裸启动、行情 403、tier=internal_eval |
| 5 | `check_rate_limit.py` | PASS | quota=60；第 61 次 429、Retry-After、problem+json、XFF 不换桶、文案不露内部码 |
| 6 | `check_entitlement_hold.py`（hold=true 真栈） | PASS | 控制表 hold=true、三接口 403、instrument 200 |
| 7 | `check_entitlement_hold.py`（stale 真栈 16min） | PASS | 控制表 last_reconciled_at 超时、三接口 403 |
| 7b | `check_entitlement_hold.py`（unreachable，socket 级） | PASS | 独立实例 `DATABASE_URL=127.0.0.1:1`；三接口 403；p95=1.9ms（20 样本）；**非真断网** |
| 8 | `check_entitlement_copy.py` | PASS 4/4 | expired/unauthorized_config/hold_active/hold_stale 文案逐字节一致 |
| 9 | `check_entitlement_events.py` | PASS | 41 条/10 类/chain 0/双源一致 |
| 10 | `check_audit_gap.py` | PASS | 键名、9 条负向 23514、exact-key、event_key 同源、gap\|unknown=0 |
| 11 | `check_entitlement_write_failure.py` | PASS | 瞬态=非阻断(200+degraded)、确定性=阻断(启动拒绝)、名单双源 7/2 |
| 12 | `check_display_safe_failclosed.py` | PASS | tushare 误写拒、删 manifest prod 拒、synthetic 忽略、篡改拒 |

13 个 transcript 在 `tests/data/acceptance/artifacts/11-12-evidence-20261104-v2.tar.gz` → `transcripts/`；每个含 exit code 与时间戳。

失败项：无。控制表跑完已 `--restore-fresh` + `hold=false`。

### 7.6 audit_gap / 002 库级约束（H4 m01945/m02004/m02043/m02068 + L70）

脚本 `tests/data/acceptance/check_audit_gap.py`（不进日常 pytest，release 跑）。当前状态：**断言已完成并在临时 scratch 库（001+新 002 全新建）自测 PASS**；`a13_verify` 待 A13 用新 002 重建后跑正式结果。

| # | 断言 | 自测结果 |
|---|------|---------|
| G1 | 002 使用 `window_start`/`window_end`，不得残留 `gap_from`/`gap_to`；event_key 分支 `gap|<uid>|<window_start>`（L70） | PASS（新 sha b93a5598；旧 sha e7a598 会红，属正确结果） |
| G2 | 负向插入 DB 拒绝：deploy 缺 `target_tier`、tier_switch 缺 from/to、observed 缺 `deployment_uid`、非 internal_eval 缺 `expires_at`、gap 缺 `window_start`/`window_end`、错键、`lost_count=0/null/-1`、`window_end<window_start` | PASS（均 SQLSTATE 23514；断言取自 psql 输出 SQLSTATE，不依赖 shell exit code） |
| G3 | 错键 `gap_from`/`gap_to` 且无 `window_start` 必须被 DB 拒绝 | PASS（A5 已改为 23514 终版；旧版 P0001 顺序问题已消除） |
| G4 | 合法 gap 可插入且 event_key 与 payload.window_start 同源（事务内 rollback）；另测 `process_restart + lost_count=null` 可插入（L71）、`process_restart + 0` 拒 | PASS（scratch 库 test_a11_gap4，2026-11-04 09:12） |
| G5 | 否定断言：`gap|unknown|%` 行数=0；库中无 `gap_from/gap_to` 的 audit_gap 残留；负向插入被拒后本脚本测试键（`dep-a11-gap*`）行数不变 | PASS |
| G6 | 事件表 10 类齐（含 audit_gap），`verify_entitlement_chain()`=0 | **PASS**（a13_verify 按 c118eeb3 重建后：35 条/10 类、chain=0；`check_entitlement_events.py` 双源 10 类/6 reason 一致、audit_gap exact-key 5 键） |

### 7.5 审计写失败分层（H4 m01875/m01904；脚本 `check_entitlement_write_failure.py`）

| # | 断言 | 结果（2026-11-04 09:04，harness+实现驱动） |
|---|------|------|
| W1 | 瞬态写失败（`connection terminated unexpectedly`）+ 有效期内 `c_end_display`：**不得误 403** | **PASS**：quote 200、`last_price=1680.5`、tier=`c_end_display`；`/healthz` `entitlement_degraded=true` reason=`audit_write_failed` |
| W2 | 瞬态写失败 + 已过期：授权本身阻断 → 403 | **PASS**：quote/bars/fundamental 403 `ENTITLEMENT_RESTRICTED`；healthz reason=`expired_event_write_failed` |
| W3 | 确定性写错误（42501）必须阻断，不得当抖动放行 | **PASS**：进程 rc=1、无 baseUrl、stderr 含「审计事件写入确定性错误（权限/表/schema），拒绝以 c_end_display 启动」；真栈 `a11_noinsert` 角色同结果 |
| W4 | 降级名单双源（实现 union vs 冻结清单） | **PASS**：BLOCKING 7（control_unavailable/control_stale/control_missing/hold_active/config_mismatch/expired/audit_write_misconfigured）、NON_BLOCKING 2（audit_write_failed/expired_event_write_failed），别名/多/少即红 |
| W5 | prod 缺 `DEPLOYMENT_UID` 启动拒绝 | **PASS**：`APP_PROFILE=prod DEPLOYMENT_UID=` → `MarketConfigError`「生产必须配置 DEPLOYMENT_UID（audit_gap 去重键与审计归属，L65）」 |
| W6 | 非 prod 缺 `DEPLOYMENT_UID`：不得写占位断口 | **BLOCKED**：`check_audit_gap.py` 已写 `gap|unknown|%` 行数=0 + 日志 `audit_gap_suppressed` 断言，等 A5 新 002 sha + A13 重建后跑 |

### 7.3 数据侧 display_safe fail-closed（H4 m01217/m01084，A2 m01329 口径；release 跑、不阻塞日常）

| # | 断言 | 命令 | 当前状态 |
|---|------|------|----------|
| 1 | tushare 批误写 `ods/display/...`：prod 非 0 退出；dev `display_safe` 全 false、不派生 true | `python3 tests/data/acceptance/check_display_safe_failclosed.py` | **PASS**（prod 拒绝、dev `display_safe_false==instruments`） |
| 2 | 删/清空 manifest：prod 非 0 退出，`load --dry-run` 也被拒，不静默全空 | 同上 | **PASS**（stderr 指出 manifest/无法派生） |
| 3 | `synthetic: true` 样例事件整条忽略：不派生 true、不进 count/链 | 同上 | **PASS**（prod 拒绝、dev 全 false） |
| 4 | 快照字节被改（`snapshot_sha256` 不符）→ prod 拒绝 | 同上 | **PASS**（复算 hash 不一致/快照哈希不符） |

### 7.9 L74 红队产物索引

见 `tests/data/acceptance/artifacts/v3/ADVERSARIAL.md`（v3 包内 `ADVERSARIAL.md`）：逐文件 path + sha256 + 字节数 + 收件时间（Asia/Shanghai），含
`http-attempts.jsonl`（**待 A19 重放**）、`results.json`、`results-r4.json`、`trustproxy-guard.json` 及两份 before-fix 对照、`REPORT.md`。
