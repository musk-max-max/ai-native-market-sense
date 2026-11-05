# real-sample-20261105（真实受控样本，非合成、非生产证据）

用途：H4 m02923 授权的一次性真实样本，只回答三个问题：fina_indicator 单位、stk_limit 比值分档、index_member_all Y/N 语义。

边界：
- 本地一次性执行，不进 CI；token 只从 `services/ingest/.env` 读取，不记录/不提交。
- `stk_limit_*.json` 为**按档位抽样**（subset=true），不是全量副本；全市场行数见 `row_count_full`。
- `index_member_all_stats.json` 为聚合统计；`index_member_all_samples.json` 只含重进样本与当前成分样本。
- **不具备生产验收证据效力**，不得被 release 证据脚本引用。

校验：`services/ingest/tools/audit_synthetic_fixtures.py` 只覆盖 `recordings/` 下的合成录制；本目录有独立 manifest，不被其统计。
