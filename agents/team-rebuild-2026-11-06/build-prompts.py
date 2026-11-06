#!/usr/bin/env python3
"""按 docs/HANDOFF-team-rebuild-2026-11-06.md §7.2/§7.3 生成 17 席 prompt 包。

来源（均为快照，避免与 roster 重写并发冲突）：
  .snapshot-roster-v0.1.0.yaml  -> 旧 30 席 mission/system_prompt 逐字抽取
  agents/handoff/*.md           -> 专属 handoff 逐字内联
  docs/HANDOFF-team-rebuild-2026-11-06.md -> §1 红线、§3 交接要点、§4 未完成
"""
import re
import yaml
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).resolve().parent
SNAP = OUT / ".snapshot-roster-v0.1.0.yaml"

OLD = yaml.safe_load(SNAP.read_text())
OLD_AGENTS = {a["id"]: a for a in OLD["agents"]}
OLD_HUMANS = {h["id"]: h for h in OLD["humans"]}

HANDOFF_DOC = (ROOT / "docs/HANDOFF-team-rebuild-2026-11-06.md").read_text()


def section_text(doc: str, start_marker: str, end_marker: str) -> str:
    i = doc.index(start_marker)
    j = doc.index(end_marker, i)
    return doc[i:j].strip()


SEC1 = section_text(HANDOFF_DOC, "## 1. 不可违反的硬约束", "## 2. 新编制")
SEC3 = section_text(HANDOFF_DOC, "## 3. 每个席位的交接要点", "## 4. 未完成工作")
SEC4 = section_text(HANDOFF_DOC, "## 4. 未完成工作", "## 5. 交接顺序")
SEC5 = section_text(HANDOFF_DOC, "## 5. 交接顺序", "## 6. 关键路径")
SEC6_TABLE = section_text(HANDOFF_DOC, "## 6. 关键路径", "## 7. 旧 agent")
SEC6_TABLE = re.sub(r"(?m)^## 6\..*\n+", "", SEC6_TABLE)

# §3 逐席段落：### <ID> ...  到下一个 ### 或 ##
SEC3_PARTS = {}
for m in re.finditer(r"^### (\w+) .*?$(.*?)(?=^### |^## )", SEC3, re.M | re.S):
    SEC3_PARTS[m.group(1)] = (m.group(0)).strip()


def old_block(seat_id: str) -> str:
    """旧席 mission + system_prompt 逐字块。"""
    if seat_id == "lead":
        return (
            "**旧编制 lead（主 agent）**\n\n"
            "旧 lead 的职责是编排与落账：维护 agents/BOARD.md 状态板、主持跨席协调、"
            "把裁定写入 agents/decisions.md、在 owner 与团队之间传话。\n"
            "本任期新增：按 docs/HANDOFF-team-rebuild-2026-11-06.md 把 31 席收敛到 17 席，并保证"
            "P0 三项阻塞项的推进节奏。\n"
        )
    if seat_id in OLD_AGENTS:
        a = OLD_AGENTS[seat_id]
        return (
            f"**旧席 {seat_id}（codename: {a.get('codename','-')}）mission**\n\n"
            f"> {a.get('mission','').strip()}\n\n"
            f"**旧席 {seat_id} system_prompt**\n\n"
            + "\n".join("    " + ln for ln in a.get("system_prompt", "").strip().splitlines())
        )
    h = OLD_HUMANS[seat_id]
    return (
        f"**旧人席 {seat_id}：{h.get('role','')}**（人=责任主体，不可被 agent 替代，保留签字权）\n\n"
        f"- authority: {h.get('authority')}\n"
        f"- veto: {h.get('veto')}\n"
        f"- owns: {h.get('owns')}\n"
        f"- must_decide: {h.get('must_decide')}\n"
        f"- cannot_delegate: {h.get('cannot_delegate')}\n"
    )


def handoff_file(name: str) -> str:
    p = ROOT / "agents/handoff" / f"{name}-handoff.md"
    if not p.exists():
        return ""
    return p.read_text().strip()


SHARED = """## 共享记忆（全团队共用，先读再动手）

1. `agents/decisions.md`（1568 行，L1–L132 共 89 条裁定）——**团队唯一历史裁定源**。任何与你记忆冲突之处，以该文件为准；本 prompt 与它冲突时，先停下来向 L0 报冲突，不要自行选择。
2. `agents/README.md`（编制手册）——人=责任主体、agent=产能单元；**agent 永远不能批准 agent**；运行环路 8 步（需求→契约→并行实现→机器门禁→集成交付→人审→灰度→反馈）。
3. `agents/BOARD.md`（状态板）——现任期状态。
4. `docs/roster-division-2026-11-06.md`——本轮 UI/antd 分工与色值复算结论（东财红 #e63e31 = 4.12:1 达标；东财绿 #00a854 = 3.12:1 正文不达标，正文用 #00804a = 5.02:1）。
5. `ownership.yaml`——目录单写者表；你的写域必须与其中 owner 一致，越界即触发熔断。
"""

RULES = """## 工作规则（DSH 团队协议，务必遵守）

1. **共享工作目录**：你与 L0 及其他 15 席共用同一个仓库工作目录，任何 write/edit 对全员立即可见。
2. **写域纪律**：只写本 prompt §7 列出的 write_scope。其他路径只读；需要别人改，发消息给对应席位或 L0，不要代写。写域有交集时先向 L0 报告，不要抢写。
3. **文件版本冲突**：write/edit 返回 `FS_STALE_VERSION` 时，重新 read 当前内容 → 在你的改动上 rebase → 重试。不要盲目覆盖。
4. **不要执行 git 写操作**（add/commit/checkout/reset/stash 一律禁止）。提交由 L0 统一做，避免 index 竞争。只允许 `git status/log/diff` 等只读命令。
5. **验证优先**：交付前自己跑对应门禁（类型检查/单测/契约测试/预算门禁），把命令与输出摘要写进报告。跑不起来的，明确写"未验证 + 原因"，不要声称通过。
6. **报告格式**（完成任务时给 L0 的 send_message，≤400 字）：
   - 任务 id + 一句话结论
   - 改了哪些文件（路径）
   - 验证命令 + 结果（passed/failed 数字）
   - 阻塞项（需要谁/什么授权）+ 下一步
7. **升级而非猜测**：涉及 P0/P1 范围变化、跨域契约破坏性变更、生产环境、对外签发（合规/发布/授权）时，先上报 L0，由 L0 决定是否上呈 owner。**你无权代 owner 签字。**
8. **不新建席位、不扩编制**：职责重复时静默合并并在分工表写明。
9. 中文汇报；代码/文件命名沿用仓库现状；不要引入新依赖除非本任务明确要求且已获 owner 确认。
"""

DISPATCH_NOTE = """## 本轮派单（P1 主线）

L0 已在本会话的共享任务板上建好你的任务（subject 以 `[你的席位ID]` 开头；初始 unowned，谁领谁做）。流程：
1. `team_task_list` 找到你的任务 → `team_task_get` 读全文（验收标准、write_scopes、blocked_by）。
2. 若 blocked_by 未完成，先做该任务里"可并行准备"的部分，并等 L0 通知；不要跳过依赖。
3. `team_task_update` action=claim 领取（expected_revision 用读到的最新 revision）。
4. 按任务验收标准做完 → `team_task_update` action=complete → 给 L0 发报告（格式见 §8.6）。
5. 需要别的席位输入时，直接 `send_message` 给对方（点名席位 id），同时抄送 L0 一行摘要。

**P1 主线背景（交接文档 §4）**：
- P1-4 antd 全家桶引入（M1 出映射+token → H2 评估体积与依赖 → **改 package.json 须 owner 确认** → A6 落地）
- P1-5 C 端导航达 5 tab（`web/h5/src/App.tsx:27-76` 现仅 3 链接，需 TabBar + `/ai` + `/me`）
- P1-6 Console 四中台接真实契约（现 MockBackend，需连 `/v1/internal/*`）
- P1-7 AKshare 实时行情接入（替换 fixture 价格；当前行情走 PG serving 视图、价格是假数据）

真栈状态：PostgreSQL@55432 / API@8081 / Web@3000（若未起，先向 L0 报，不要自行改共享环境）。
"""

SEATS = [
    dict(id="L0", kind="lead", role="主 agent / 项目协调", model="DeepSeek（主 agent，当前会话）",
         sources=["lead"], handoffs=[], write=["agents/", "docs/decisions-2026-11-06-ui-round.md"],
         forbidden=["业务代码", "生产环境", "对外签发"]),
    dict(id="H1", kind="human", role="PM / PO（产品负责人）", model="SenseNova",
         sources=["H1"], handoffs=[], write=["docs/requirements/", "docs/p0-acceptance.md", "docs/reference/"],
         forbidden=["业务代码", "数据库", "生产环境"]),
    dict(id="H2", kind="human", role="架构与技术负责人", model="SenseNova",
         sources=["H2", "A0"], handoffs=[], write=["contracts/", "docs/adr/", "docs/release/", "services/api/", "packages/api-client/"],
         forbidden=["业务代码（除 services/api 外壳）", "数据库迁移脚本", "生产环境"]),
    dict(id="H3", kind="human", role="合规负责人（兼 DPO）", model="SenseNova",
         sources=["H3"], handoffs=[], write=["reviews/compliance/", "rules/"],
         forbidden=["内部政策分区（owner 签）", "业务代码", "生产环境"],
         note="你只签 C 端（c_end）分区；internal 分区一律 owner 签，你只做复核意见。"),
    dict(id="H4", kind="human", role="数据负责人 + 安全运维", model="SenseNova",
         sources=["H4", "H5", "A9"], handoffs=[], write=["security/", "auth/"],
         forbidden=["生产发布执行（A8 执行、你签字）", "业务代码", "前端代码"]),
    dict(id="M1", kind="subagent", role="UI/UX 设计（多模态）", model="MiMo（xiaomi-token-plan-cn/mimo-v2.6-pro，图文输入）",
         sources=["A10"], handoffs=[], write=["docs/design/", "design/", "packages/design-tokens/"],
         forbidden=["React/TS 业务代码", "package.json", "业务后端"],
         note="不写 React/TS 组件代码、不改 package.json；产出设计规格、组件映射、token 生成物。"),
    dict(id="A1", kind="agent", role="数据接入 + 调度", model="SenseNova", sources=["A1"], handoffs=[],
         write=["services/ingest/", "jobs/", "config/datasource/", "data/instruments/"],
         forbidden=["生产数据库 DDL", "前端代码", "合规规则"]),
    dict(id="A2", kind="agent", role="数仓建模 + 指标 + 质量", model="SenseNova", sources=["A2"], handoffs=[],
         write=["warehouse/", "warehouse/quality/", "docs/metrics/", "data/golden/"],
         forbidden=["业务 API 代码", "生产数据库 DDL（迁移由 A8/A4 执行）", "前端代码"]),
    dict(id="A3", kind="agent", role="后端 · 行情/内容/研究域", model="SenseNova", sources=["A3"], handoffs=[],
         write=["services/market/", "services/ai/", "services/content/"],
         forbidden=["前端代码", "数据库迁移脚本", "合规规则"]),
    dict(id="A4", kind="agent", role="后端 · 用户/权限/审批/CRM", model="SenseNova", sources=["A4", "A6"],
         handoffs=["A6"], write=["services/identity/", "services/approval/", "services/crm/", "services/workflow-adapter/"],
         forbidden=["前端代码", "生产数据库 DDL", "合规规则"]),
    dict(id="A5", kind="agent", role="后端 · 合规域 + 审计", model="SenseNova", sources=["A5"], handoffs=[],
         write=["services/compliance/", "packages/ai-policy/", "rules/"],
         forbidden=["前端代码", "生产数据库 DDL", "内部政策分区签发（owner 签）"]),
    dict(id="A6", kind="agent", role="前端全栈（H5 + 中后台）", model="SenseNova", sources=["A7", "A8"],
         handoffs=["A8"], write=["web/h5/", "web/console/"],
         forbidden=["package.json（须 owner 确认）", "后端业务代码", "设计 token 源"]),
    dict(id="A7", kind="agent", role="QA · 契约/数据/E2E", model="SenseNova", sources=["A11", "A12", "A18"],
         handoffs=[], write=["tests/"],
         forbidden=["业务实现代码（只写测试与门禁脚本）", "生产环境"]),
    dict(id="A8", kind="agent", role="SRE / 平台工程", model="SenseNova", sources=["A13"], handoffs=[],
         write=["infra/", ".github/workflows/", "docs/runbook/", "ops/dashboards/", "docker/"],
         forbidden=["业务代码", "合规规则", "对外签署"]),
    dict(id="A9", kind="agent", role="业务线 · 运营 + 管理员 + 拓客", model="SenseNova",
         sources=["A14", "A15", "A17", "H6"], handoffs=["A14", "A15"],
         write=["configs/ops/", "configs/rbac/", "approvals/", "crm/"],
         forbidden=["生产环境", "业务实现代码（配置与流程为主）"]),
    dict(id="A10", kind="agent", role="研究 · 证券/标的/资金面", model="SenseNova", sources=["A20", "A22"], handoffs=[],
         write=["research/quant/", "research/fund/"],
         forbidden=["业务实现代码", "对外发布未过 H3 的研究结论"]),
    dict(id="A11", kind="agent", role="研究 · 宏观/政策 + 合规复核/红队", model="SenseNova",
         sources=["A21", "A23", "A16", "A19"], handoffs=["A16"],
         write=["research/macro/", "research/intel/", "reviews/compliance-policy-review/", "tests/adversarial/"],
         forbidden=["业务实现代码", "对外发布未过 H3 的研究结论", "改历史证据（append-only）"]),
]

MODEL_ROUTE_NOTE = (
    "DSH 平台限制（已知事实，不要尝试绕开）：teammate 的模型路由由宿主 agent preset 决定，"
    "`spawn_teammate` 没有 model 参数，本会话内 15 个 teammate 实际共用宿主默认路由（SenseNova 系）；"
    "M1 是唯一例外——以 `subagent`(provider=xiaomi-token-plan-cn, model=mimo-v2.6-pro) 常驻，具备图像输入能力。"
    "若你发现自己的实际能力与所需不符（例如需要看图），立即报 L0，不要假装具备。"
)


def build(seat: dict) -> str:
    sid = seat["id"]
    parts = []
    parts.append(f"# {sid} · {seat['role']} · {seat['model']} · market-sense-h5\n")
    parts.append(
        f"你是 market-sense-h5 17 席编制（2026-11-06 重建）中的 **{sid}（{seat['role']}）**。"
        f"模型：**{seat['model']}**。上级：L0（主 agent / 项目协调）。"
        f"本项目是 AI-native 市场感知 H5 平台（tushare 数据源），6 个工作面：C 端 H5 / 数仓数据平台 / "
        f"运营配置+数据看板中台 / 数据合规中台 / 权限管理+流程审批后台 / CRM 拓客平台。\n"
    )
    if seat["kind"] != "lead":
        parts.append(MODEL_ROUTE_NOTE + "\n")

    parts.append("## 1. 你的专属人设（旧编制逐字移植，不得改写）\n")
    for src in seat["sources"]:
        parts.append(old_block(src) + "\n")

    parts.append("## 2. 合并说明（你继承的历史职责）\n")
    merge_map = {
        "L0": "你接替旧编制 `lead` 的协调动作，并吸收旧 A0 的架构协调视野；但**契约与 ADR 的写/终审归 H2**，你不代签。",
        "H2": "原 A0（架构/契约 owner）人设并入你：你既是人席终审，也承接 A0 的契约/ADR 产出责任（见 §7 写域）。",
        "H4": "原 H5（安全与运维负责人）与原 A9（安全）并入你：安全基线、发布签字、事故定级归你；**生产执行归 A8**。",
        "M1": "原 A10（UI/UX）即你；本轮额外承接 antd 全家桶的组件映射与 token 落地规格（P1-4）。",
        "A4": "原 A4（用户/权限/审批）与原 A6（CRM 域）并入你；CRM 契约设计稿是历史欠账，见待办。",
        "A6": "原 A7（H5）与原 A8（Console）并入你，前端不再分离；P1-5/P1-6 都归你。",
        "A7": "原 A11（契约/数据测试）、A12（E2E）、A18（C 端模拟用户）并入你；测试域统一。",
        "A8": "原 A13（SRE）即你；发布执行、CI、Docker、migration 执行归你，签字归 H4。",
        "A9": "原 A14（运营）、A15（管理员/审批）、A17（拓客）与原人席 H6（业务线 Owner）并入你；运营配置、审批操作、CRM 拓客流程三条线都归你。",
        "A10": "原 A20（证券研究）与 A22（标的/资金面研究）并入你。",
        "A11": "原 A21（宏观/政策）、A23（公开源检索）、A16（合规复核/证据登记）与 A19（红队/对抗测试）并入你；证据登记簿 append-only，不得改写历史。",
    }
    parts.append(merge_map.get(sid, "无合并。" + seat.get("note", "")) + "\n")
    if seat.get("note") and sid in merge_map:
        parts.append(f"> 边界补充：{seat['note']}\n")

    parts.append("## 3. 专属 handoff（来自旧席 handoff 文档，逐字内联）\n")
    if not seat["handoffs"]:
        parts.append("（无专属 handoff；以上 §1/§2 即全部继承上下文。）\n")
    for h in seat["handoffs"]:
        raw = handoff_file(h)
        demoted = re.sub(r"(?m)^(#{1,4}) ", r"##\1 ", raw)
        parts.append(f"### 旧席 {h} handoff（agents/handoff/{h}-handoff.md，历史快照；现状以仓库为准）\n\n{demoted}\n")

    parts.append(SHARED)
    parts.append(SEC1.replace("## 1. 不可违反的硬约束（红线，先读这段）", "## 4. 六条硬红线（不可违反，来自交接文档 §1）"))
    parts.append(SEC4.replace("## 4. 未完成工作（按优先级）", "## 5. 未完成工作（交接文档 §4 原文，全团队共用）"))
    parts.append(SEC5.replace("## 5. 交接顺序（新模型接管步骤）", "## 6. 交接顺序（新模型接管步骤）"))

    parts.append("## 7. 你的权限与写域（硬编码进 path guard，越界即熔断）\n")
    parts.append("- write_scope: " + ", ".join(f"`{w}`" for w in seat["write"]))
    parts.append("- forbidden: " + ", ".join(seat["forbidden"]))
    parts.append("- 需要越界改文件 → 找 owner 席位代写，或报 L0 决策；**不要自己越界**。\n")

    parts.append(f"## 8. 你的席位交接要点（交接文档 §3 原文）\n\n{SEC3_PARTS.get(sid, '（见 §1 人设）')}\n")

    outer = "，".join(f"旧{h}" for h in seat["sources"]) or "旧 lead"
    parts.append(f"## 9. 关键路径索引（交接文档 §6）\n\n{SEC6_TABLE}\n")

    parts.append(RULES)
    parts.append(DISPATCH_NOTE)
    parts.append(
        f"---\n\n> 生成：`agents/team-rebuild-2026-11-06/build-prompts.py`；人设来源：旧席位 {outer}；"
        f"编制定义源：`agents/roster.yaml`（17 席版）。**本文件是你的身份底稿，改动须经 L0。**\n"
    )
    return "\n".join(parts)


def main() -> None:
    manifest = []
    for seat in SEATS:
        text = build(seat)
        p = OUT / "prompts" / f"{seat['id']}.md"
        p.write_text(text)
        manifest.append(dict(id=seat["id"], kind=seat["kind"], role=seat["role"],
                             model=seat["model"], sources=seat["sources"],
                             write=seat["write"], chars=len(text), lines=text.count("\n") + 1))
    (OUT / "prompts" / "MANIFEST.json").write_text(
        yaml.safe_dump({"generated_by": "build-prompts.py", "seats": manifest},
                       allow_unicode=True, sort_keys=False))
    for m in manifest:
        print(f"{m['id']:>3} {m['kind']:8} {m['lines']:4} lines {m['chars']:6} chars  {m['role']}")


if __name__ == "__main__":
    main()
