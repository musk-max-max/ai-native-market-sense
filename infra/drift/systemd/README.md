# HOST-EXPOSURE-01 部署（systemd timer）

安装（ECS，仅 A13 执行）：

```sh
install -m 0755 infra/drift/host-baseline-audit.sh /usr/local/sbin/market-sense-host-baseline-audit.sh
install -d /etc/market-sense
install -m 0644 infra/drift/host-baseline.expected.env /etc/market-sense/host-baseline.expected.env
install -m 0644 infra/drift/systemd/market-sense-host-baseline.service /etc/systemd/system/
install -m 0644 infra/drift/systemd/market-sense-host-baseline.timer /etc/systemd/system/
install -d /var/lib/node_exporter/textfile_collector
systemctl daemon-reload
systemctl enable --now market-sense-host-baseline.timer
systemctl start market-sense-host-baseline.service   # 首次执行
```

观测：`systemctl list-timers market-sense-host-baseline.timer`、`journalctl -u market-sense-host-baseline.service -n 50`；
指标 `host_baseline_exposure_hits`（node_exporter textfile）→ 告警 `HostExposureDrift`。

回滚：`systemctl disable --now market-sense-host-baseline.timer`（不影响已隔离容器的 restart=no，需人工恢复）。
