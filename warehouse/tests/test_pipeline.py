"""pipeline CLI 的 fail-closed 行为：缺证券主数据时不得输出质量分。"""

from __future__ import annotations

from warehouse.golden_runner import _write_envelope
from warehouse.pipeline import main
from warehouse.tests.helpers import bar_row, envelopes, factor_row


def test_missing_instrument_master_fails_closed(tmp_path, capsys):
    # A1 P0 首版只产 bar.v1 + adj_factor.v1：pipeline 必须显式拒绝，而不是拿空 dim 出分
    envs = envelopes(
        instrument=None,
        bars=[bar_row()],
        factors=[factor_row()],
    )
    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    code = main(["--ods-root", str(tmp_path)])
    assert code == 2
    err = capsys.readouterr().err
    assert "instrument.v1" in err
    assert "dim_instrument" in err


def test_instrument_master_present_runs_gate(tmp_path, capsys):
    envs = envelopes(bars=[bar_row()], factors=[factor_row()])
    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    # 单日 bar 在 COMP-03 工作日覆盖口径下可能报缺口，只验证它真的走到质量分（不是 fail-closed 路径）
    main(["--ods-root", str(tmp_path)])
    out = capsys.readouterr()
    assert "缺少 instrument.v1" not in out.err
