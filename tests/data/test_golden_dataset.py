"""golden dataset 回归：用独立参考实现校验 A2 的数据包（data/golden/）。

门禁语义：
- 每条 case 的 grade / blocked / violations 必须与数据包内写死的 expect 完全一致；
- P0 包必须覆盖 H4 批准的边界类（ST / 停牌 / 退市 / 新股首日 / 除权除息 / 涨跌停 / 北交所 / 科创）；
- expect 里的复权数字（hfq/qfq）必须能由 close × factor 确定性算出（黄金数字不许拍脑袋）。

红灯归属：数据包错（A2 修）/ 期望错（H4+A2 修）/ 参考实现错（A11 修，禁止改期望绕过）。
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

import pytest

from quality_lib import (
    CATEGORY_ORDER,
    CaseData,
    evaluate_case,
    load_pack,
    load_policy,
    pack_path_from_env,
    parse_date,
    parse_decimal,
)

PACK_PATH = pack_path_from_env()


@pytest.fixture(scope="module")
def pack():
    return load_pack(PACK_PATH)


@pytest.fixture(scope="module")
def policy():
    return load_policy()


@pytest.fixture(scope="module")
def reports(pack, policy):
    return {case.case_id: evaluate_case(pack, case, policy) for case in pack.cases}


def test_pack_is_versioned_and_owned(pack):
    meta = pack.meta
    assert isinstance(meta.get("version"), int) and meta["version"] >= 1, "数据包必须版本化（meta.version）"
    assert meta.get("owner") == "A2", f"golden 数据包 owner 应为 A2，实际 {meta.get('owner')!r}"
    assert meta.get("decision_refs"), "数据包必须能追溯到决策编号（H4-D6..D9 / ADR-002）"
    assert all(case.expect.get("grade") for case in pack.cases), "每个 case 必须带 expect.grade"


def test_p0_slice_size_is_approved(pack):
    """H4 批准口径：golden 500 条的 P0 先取 20 条正例（+ 负例）。"""
    positives = [case for case in pack.cases if case.case_id.startswith("G")]
    negatives = [case for case in pack.cases if case.case_id.startswith("N")]
    assert len(positives) >= 20, (
        f"P0 正例不得少于 20 条（H4 批准切片；A2 2026-11-04 补 G21 ST 5% 边界后为 21），实际 {len(positives)}"
    )
    assert negatives, "P0 必须包含负例（否则规则只会被正例「顺带」覆盖，无法证明能拦坏数据）"


def test_case_ids_are_unique(pack):
    ids = [case.case_id for case in pack.cases]
    assert len(ids) == len(set(ids)), "case id 重复"


@pytest.mark.parametrize("case", load_pack(PACK_PATH).cases, ids=lambda case: case.case_id)
def test_case_matches_expected_verdict(case: CaseData, reports):
    """逐条对比独立实现的判定与 A2 写死的期望。"""
    report = reports[case.case_id]
    expect = case.expect
    assert report.grade == expect["grade"], (
        f"{case.case_id} grade 期望 {expect['grade']} 实际 {report.grade}（score={report.score}, "
        f"violations={sorted(report.rule_ids)}）"
    )
    assert report.blocked == expect["blocked"], (
        f"{case.case_id} blocked 期望 {expect['blocked']} 实际 {report.blocked}"
    )
    expected_rules = sorted(expect.get("violations") or [])
    assert sorted(report.rule_ids) == expected_rules, (
        f"{case.case_id} 违规规则不一致：期望 {expected_rules} 实际 {sorted(report.rule_ids)}\n"
        f"明细: {[(v.rule_id, v.detail) for v in report.violations]}"
    )


def test_positive_cases_have_no_blocker(pack, reports):
    """正例必须是「干净数据」：任何 blocker 都意味着 golden 本身在教坏数据。"""
    dirty = [
        f"{case.case_id}: {sorted(reports[case.case_id].rule_ids)}"
        for case in pack.cases
        if case.case_id.startswith("G") and reports[case.case_id].violations
    ]
    assert not dirty, "正例出现违规: " + "; ".join(dirty)


def test_p0_boundary_classes_are_covered(pack):
    """H4 批准的 P0 边界类必须各有样本，否则「500 条含 150 条边界」在 P0 就已失守。"""
    def bars_of(case):
        return case.bars

    board_classes = {case.instrument.get("board") for case in pack.cases}
    assert "bse" in board_classes, "缺北交所样本（±30% 幅度）"
    assert "star" in board_classes, "缺科创板样本（±20% 幅度）"
    assert any((case.instrument.get("name") or "").startswith(("ST", "*ST")) for case in pack.cases), "缺 ST 样本"
    assert any(case.suspended for case in pack.cases), "缺停牌证据样本（C08）"
    assert any(case.instrument.get("list_status") == "delisted" for case in pack.cases), "缺退市样本（C14）"
    assert any(
        parse_date(case.instrument.get("listed_at")) is not None
        and bars_of(case)
        and min(parse_date(bar["trade_date"]) for bar in bars_of(case)) == parse_date(case.instrument["listed_at"])
        for case in pack.cases
    ), "缺新股/上市首日样本"
    assert any(
        case.factors
        and len({row["factor"] for row in case.factors}) > 1
        for case in pack.cases
    ), "缺除权除息样本（因子变化）"


def test_limit_up_and_down_prices_are_exercised(pack, policy):
    """涨跌停必须按板块价格四舍五入到分命中（C11 不得硬编码 10%）。"""
    hits = {"limit_up": False, "limit_down": False}
    step = Decimal("0.01")
    for case in pack.cases:
        board = case.instrument.get("board")
        name = case.instrument.get("name") or ""
        limit = (
            policy["st_limit_pct"]
            if name.startswith(("ST", "*ST")) and board in policy["st_limit_boards"]
            else policy["board_limit_pct"][board]
        )
        for bar in case.bars:
            prev = parse_decimal(bar.get("prev_close"))
            close = parse_decimal(bar.get("close"))
            if prev is None or close is None or prev <= 0:
                continue
            up = (prev * (1 + Decimal(str(limit)) / 100)).quantize(step, rounding=ROUND_HALF_UP)
            down = (prev * (1 - Decimal(str(limit)) / 100)).quantize(step, rounding=ROUND_HALF_UP)
            if close == up:
                hits["limit_up"] = True
            if close == down:
                hits["limit_down"] = True
    assert hits["limit_up"], "缺涨停价样本（含分位舍入）"
    assert hits["limit_down"], "缺跌停价样本"


def test_st_uses_five_percent_cap_not_ten(pack, policy):
    """ST 必须按 5% 判定：超 5% 的 ST 涨跌幅要被 BIZ-01 拦下。

    A2 已补 G21（ST 恰好 +5.00%），因此这里要求：恰好 5% 放行、>5%+容差被拦，
    同时防「硬编码 10%」回归（+6% 在 10% 口径下会被误放行）。
    """
    st_cases = [c for c in pack.cases if (c.instrument.get("name") or "").startswith(("ST", "*ST"))]
    assert st_cases, "缺 ST 样本"
    changes = []
    for case in st_cases:
        for bar in case.bars:
            prev = parse_decimal(bar.get("prev_close"))
            close = parse_decimal(bar.get("close"))
            if prev and close:
                changes.append((case.case_id, float((close / prev - 1) * 100), case.expect.get("violations") or []))
    over = [row for row in changes if row[1] > policy["st_limit_pct"] + policy["limit_tolerance_pp"]]
    assert over, "缺 ST 超 5% 幅度样本，ST 5% 规则未被真实触发"
    assert all("BIZ-01" in violations for _, _, violations in over), (
        "ST 超过 5%+容差却被放行（疑似硬编码 10%）: " + repr(over)
    )
    within = [row for row in changes if row[1] <= policy["st_limit_pct"]]
    assert all("BIZ-01" not in violations for _, _, violations in within), (
        "ST 在 5% 以内（含）的合法涨跌幅被误判 BIZ-01: " + repr(within)
    )
    assert any(abs(row[1] - policy["st_limit_pct"]) < 1e-9 for row in changes), (
        "缺「ST 恰好 5%」边界样本（G21 是 H4 要求补的样本，被删即红灯）"
    )


def test_expect_adjustment_numbers_are_derivable(pack):
    """expect.hfq / qfq_first 必须由 close × factor 算出（黄金数字不得手工拍）。"""
    problems = []
    for case in pack.cases:
        expect = case.expect
        if "hfq" not in expect:
            continue
        assert case.factors, f"{case.case_id}: 声明了 hfq 期望但没有 factors"
        factor_by_date = {parse_date(row["trade_date"]): parse_decimal(row["factor"]) for row in case.factors}
        ordered = sorted(case.bars, key=lambda bar: bar["trade_date"])
        first, last = ordered[0], ordered[-1]
        first_factor = factor_by_date[parse_date(first["trade_date"])]
        last_factor = factor_by_date[parse_date(last["trade_date"])]
        hfq_first = (parse_decimal(first["close"]) * first_factor).quantize(Decimal("0.0001"))
        hfq_last = (parse_decimal(last["close"]) * last_factor).quantize(Decimal("0.0001"))
        if str(hfq_first) != expect["hfq"]["first"]:
            problems.append(f"{case.case_id}: hfq.first 期望 {expect['hfq']['first']} 实际 {hfq_first}")
        if str(hfq_last) != expect["hfq"]["last"]:
            problems.append(f"{case.case_id}: hfq.last 期望 {expect['hfq']['last']} 实际 {hfq_last}")
        if "qfq_first" in expect:
            qfq_first = (parse_decimal(first["close"]) * first_factor / last_factor).quantize(
                Decimal("0.0001"), rounding=ROUND_HALF_UP
            )
            if str(qfq_first) != expect["qfq_first"]:
                problems.append(f"{case.case_id}: qfq_first 期望 {expect['qfq_first']} 实际 {qfq_first}")
    assert not problems, "\n".join(problems)


def test_every_category_participates(pack, policy, reports):
    """四类校验都必须真的被评估过（避免某类因实现缺口恒为 100 分）。"""
    category_of = {rule_id: meta["category"] for rule_id, meta in policy["rules"].items()}
    evaluated = {category: 0 for category in CATEGORY_ORDER}
    for report in reports.values():
        for rule_id, count in report.evaluated.items():
            evaluated[category_of[rule_id]] += count
    empty = [category for category, total in evaluated.items() if total == 0]
    assert not empty, f"以下类别没有任何评估（数据校验规则覆盖率缺口）: {empty}"
