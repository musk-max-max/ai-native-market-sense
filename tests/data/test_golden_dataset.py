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
    is_s_share,
    limit_pct_for,
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
    """正例不得出现 blocker（golden 本身不能教坏数据）。

    L80 例外：ST 时点性 warn（BIZ-03）是 known limitation 的**标注**，不是数据错误；
    正例允许 warn，blocker 仍一票否决。"""
    dirty = [
        f"{case.case_id}: {sorted(v.rule_id for v in reports[case.case_id].violations if v.severity == 'blocker')}"
        for case in pack.cases
        if case.case_id.startswith("G")
        and any(v.severity == "blocker" for v in reports[case.case_id].violations)
    ]
    assert not dirty, "正例出现 blocker: " + "; ".join(dirty)


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


def _bar_limits(cases, policy):
    """逐 bar 计算 (case, trade_date, trade_seq, limit_pct, change_pct, violations)。"""
    rows = []
    for case in cases:
        instrument = case.instrument
        listed_at = parse_date(instrument.get("listed_at"))
        bars = sorted(case.bars, key=lambda bar: bar.get("trade_date") or "")
        for position, bar in enumerate(bars, start=1):
            trade_date = parse_date(bar.get("trade_date"))
            prev = parse_decimal(bar.get("prev_close"))
            close = parse_decimal(bar.get("close"))
            change = None
            if prev is not None and close is not None and prev > 0:
                change = (close / prev - 1) * 100
            limit = limit_pct_for(
                policy,
                board=instrument.get("board"),
                name=instrument.get("name") or "",
                listed_at=listed_at,
                trade_date=trade_date,
                trade_seq=position,
            )
            rows.append((case, trade_date, position, limit, change, case.expect.get("violations") or []))
    return rows


def test_limit_up_and_down_prices_are_exercised(pack, policy):
    """涨跌停必须按「时点/板块档位」四舍五入到分命中（C11 不得硬编码 10%）。"""
    hits = {"limit_up": False, "limit_down": False}
    step = Decimal("0.01")
    for case, _, _, limit, _, _ in _bar_limits(pack.cases, policy):
        if limit is None:
            continue
        for bar in case.bars:
            prev = parse_decimal(bar.get("prev_close"))
            close = parse_decimal(bar.get("close"))
            if prev is None or close is None or prev <= 0:
                continue
            up = (prev * (1 + limit / 100)).quantize(step, rounding=ROUND_HALF_UP)
            down = (prev * (1 - limit / 100)).quantize(step, rounding=ROUND_HALF_UP)
            if close == up:
                hits["limit_up"] = True
            if close == down:
                hits["limit_down"] = True
    assert hits["limit_up"], "缺涨停价样本（含分位舍入）"
    assert hits["limit_down"], "缺跌停价样本"


def test_st_main_limit_is_time_aware(pack, policy):
    """主板 ST 档位随时点变化（L118/L119）：<2026-07-06 = 5%，>= = 10%。

    证明三件事：①5% 档内不误报且存在「恰好 5%」样本（G21，被删即红灯）；
    ②5% 档超限被拦（N05 +6%，防退回 10% 硬编码）；③10% 档恰好 10% 放行（G26，防仍按 5%）。
    """
    tolerance = float(policy["limit_tolerance_pp"])
    rows = [
        row
        for row in _bar_limits(pack.cases, policy)
        if (row[0].instrument.get("board") == "main")
        and (row[0].instrument.get("name") or "").startswith(("ST", "*ST"))
        and not is_s_share(row[0].instrument.get("name") or "")
        and row[3] is not None
        and row[4] is not None
    ]
    before = [row for row in rows if row[3] == Decimal("5")]
    after = [row for row in rows if row[3] == Decimal("10")]
    assert before, "缺 2026-07-06 前主板 ST（5%）样本"
    assert after, "缺 2026-07-06 起主板 ST（10%）样本"

    exact_before = [row for row in before if abs(float(row[4]) - 5.0) < 1e-9]
    assert exact_before, "缺「ST 恰好 5%」边界样本（G21 被删即红灯）"
    assert all("BIZ-01" not in row[5] for row in exact_before), "5% 档恰好 5% 被误判 BIZ-01"

    over_before = [row for row in before if abs(float(row[4])) > 5.0 + tolerance]
    assert over_before, "缺「5% 档超限」负样本（N05）"
    assert all("BIZ-01" in row[5] for row in over_before), "5% 档超限被放行（疑似硬编码 10%）"

    exact_after = [row for row in after if abs(float(row[4]) - 10.0) < 1e-9]
    assert exact_after, "缺「ST 恰好 10%」样本（G26 被删即红灯）"
    assert all("BIZ-01" not in row[5] for row in exact_after), "10% 档恰好 10% 被误判 BIZ-01（疑似仍按 5%）"


def test_no_limit_windows_follow_registration_and_bse_rules(pack, policy):
    """首日/注册制前 5 交易日/北交所开市前 → limit_pct=NULL，不得错标涨停（L120）。"""
    rows = {case.case_id: [row for row in _bar_limits([case], policy)] for case in pack.cases}
    by_case = {case.case_id: case for case in pack.cases}

    for case_id in ("G35", "G36", "G37"):
        case_rows = rows[case_id]
        assert all(row[3] is None for row in case_rows), f"{case_id}: 注册制前 5 交易日必须 NULL"
        assert "BIZ-01" not in (by_case[case_id].expect.get("violations") or [])

    for case_id in ("N10", "N11", "N12"):
        case_rows = rows[case_id]
        assert case_rows[-1][3] is not None, f"{case_id}: 第 6 个交易日起必须恢复档位"
        assert "BIZ-01" in (by_case[case_id].expect.get("violations") or [])

    bse_early = [row for row in rows["G30"] if row[3] is None]
    assert bse_early, "G30：北交所 2021-11-15 前必须 NULL"
    assert all(row[3] == Decimal("30") for row in rows["G31"]), "G31：北交所开市后必须 30%"

    s_share = [row for row in rows["G29"] if row[3] is not None]
    assert s_share and all(row[3] == Decimal("5") for row in s_share), "G29：主板 S 股必须 5%"


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
