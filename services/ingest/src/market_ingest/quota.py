"""限流 + 配额守卫（ADR-002 与 roster system_prompt 规则 2/3）。

原则：
- **只吃 80% 配额**：``reserve_ratio`` 的配额永远不用满；速率与周期上限都按 80% 折算。
- **可预算**：``run_budget_calls`` 是本次运行硬上限，超限立即 ``QuotaExhaustedError``（不可重试）。
- **可续跑**：已用调用数落 ``quota_ledger``（跨运行/跨进程），不依赖进程内计数。
- **可区分**：配额耗尽抛 ``QuotaExhaustedError``（retryable=False），与「可重试的限流」区分。
"""

from __future__ import annotations

import time as _time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from math import floor
from typing import Protocol

from .models import MARKET_TZ, market_now
from .ports import InvalidRequestError, QuotaExhaustedError


class CallLedger(Protocol):
    """配额台账：按 ``period_key``（自然日，Asia/Shanghai）累计已用调用数。"""

    def get_calls(self, period_key: str) -> int: ...

    def add_calls(self, period_key: str, count: int, updated_at: datetime) -> int: ...


@dataclass
class InMemoryCallLedger:
    """测试/单进程用台账；生产用 ``storage.SqliteStorage``（同一接口）。"""

    calls: dict[str, int] | None = None

    def __post_init__(self) -> None:
        if self.calls is None:
            self.calls = {}

    def get_calls(self, period_key: str) -> int:
        assert self.calls is not None
        return self.calls.get(period_key, 0)

    def add_calls(self, period_key: str, count: int, updated_at: datetime) -> int:
        assert self.calls is not None
        self.calls[period_key] = self.calls.get(period_key, 0) + count
        return self.calls[period_key]


def period_key(now: datetime) -> str:
    """配额周期键：市场自然日 ``YYYYMMDD``（Asia/Shanghai）。"""
    return now.astimezone(MARKET_TZ).strftime("%Y%m%d")


@dataclass(frozen=True, slots=True)
class QuotaPolicy:
    """配额策略。``calls_per_minute`` / ``period_cap_calls`` 是数据源套餐上限。"""

    calls_per_minute: int = 500
    reserve_ratio: float = 0.2
    period_cap_calls: int | None = None
    run_budget_calls: int | None = None  # 本次运行硬上限（由 CLI 显式给出，不二次打折）

    def __post_init__(self) -> None:
        if self.calls_per_minute < 1:
            raise ValueError("calls_per_minute must be >= 1")
        if not 0.0 <= self.reserve_ratio < 1.0:
            raise ValueError("reserve_ratio must be in [0, 1)")
        if self.period_cap_calls is not None and self.period_cap_calls < 1:
            raise ValueError("period_cap_calls must be >= 1 when set")
        if self.run_budget_calls is not None and self.run_budget_calls < 1:
            raise ValueError("run_budget_calls must be >= 1 when set")

    @property
    def effective_calls_per_minute(self) -> int:
        """留出 reserve 后每分钟允许的调用数（至少 1）。"""
        return max(1, floor(self.calls_per_minute * (1.0 - self.reserve_ratio)))

    @property
    def effective_period_cap(self) -> int | None:
        if self.period_cap_calls is None:
            return None
        return max(1, floor(self.period_cap_calls * (1.0 - self.reserve_ratio)))

    @property
    def min_interval_s(self) -> float:
        return 60.0 / self.effective_calls_per_minute

    def with_run_budget(self, run_budget_calls: int | None) -> QuotaPolicy:
        return QuotaPolicy(
            calls_per_minute=self.calls_per_minute,
            reserve_ratio=self.reserve_ratio,
            period_cap_calls=self.period_cap_calls,
            run_budget_calls=run_budget_calls,
        )


class QuotaGuard:
    """调用前守卫：先预算、再配额、再限速，最后记账。

    记账发生在真正发起调用之前：即使调用失败，源侧也通常已计一次配额，
    因此宁可保守多记，不可少记。任何 ``QuotaExhaustedError`` 之前不 sleep，
    保证「配额耗尽」能立即向上冒泡（sync 落 checkpoint 后退出码 3）。
    """

    def __init__(
        self,
        policy: QuotaPolicy,
        ledger: CallLedger,
        *,
        clock: Callable[[], datetime] = market_now,
        sleep: Callable[[float], None] = _time.sleep,
    ) -> None:
        self.policy = policy
        self._ledger = ledger
        self._clock = clock
        self._sleep = sleep
        self.run_calls = 0
        self.waited_s = 0.0
        self._last_call_at: datetime | None = None

    @property
    def remaining_run_budget(self) -> int | None:
        if self.policy.run_budget_calls is None:
            return None
        return self.policy.run_budget_calls - self.run_calls

    def acquire(self, calls: int = 1, *, endpoint: str | None = None) -> None:
        """占用 ``calls`` 次配额；不允许时抛 ``QuotaExhaustedError``。"""
        if calls < 1:
            raise InvalidRequestError(f"calls must be >= 1, got {calls}")
        budget = self.policy.run_budget_calls
        if budget is not None and self.run_calls + calls > budget:
            raise QuotaExhaustedError(
                f"run budget exhausted: used {self.run_calls}/{budget} calls"
                + (f" (endpoint={endpoint})" if endpoint else "")
            )

        now = self._clock()
        key = period_key(now)
        cap = self.policy.effective_period_cap
        if cap is not None:
            used = self._ledger.get_calls(key)
            if used + calls > cap:
                raise QuotaExhaustedError(
                    f"daily quota reserve reached: used {used}/{cap} calls for {key} "
                    f"(reserve_ratio={self.policy.reserve_ratio})"
                )

        if self._last_call_at is not None:
            elapsed = (now - self._last_call_at).total_seconds()
            wait_s = self.policy.min_interval_s - elapsed
            if wait_s > 0:
                self._sleep(wait_s)
                self.waited_s += wait_s
                now = self._clock()

        self._ledger.add_calls(key, calls, now)
        self.run_calls += calls
        self._last_call_at = now
