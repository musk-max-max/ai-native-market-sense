# A19 取证边界违规记录（事故 / near-miss，非验收证据）

- authority: `drill`（按 H5 m01205：事故/演练语义，不进验收签字包）
- 记录人: A19（a19-red-team）　复核人: H5（待签）　日期: 2026-11-05
- 关联 artifact: `infra/evidence/internal-exposure-redteam-20261104T2356Z.txt`
  - sha256 `afbeaf526b252a09d14e78a6170e2be1e19f5a0d7d0e3d754ca2522bc8c76653`，bytes 19,427
  - 该 artifact 为 authoritative / post-fix，行号引用均指该文件
- 事件等级: **P2 程序违规（near-miss）**，非 P1；P1 仍为 R2（SSH root 密码认证）

## 1. 事实

- 2026-11-04（UTC 约 23:49–23:50，artifact 顺序 E1→E4；未记录精确到秒的起止时间）。
- 在 ECS `heyuan`（公网 `47.120.16.239`）上临时启动 `python http.server`，绑定 `0.0.0.0:8888` 与 `0.0.0.0:80`，各约 2 秒（artifact 第 116 行「2s 内启停」；未记录每端口精确秒数）。
- artifact 第 117–118 行：两条 `LISTEN 0.0.0.0:8888` / `0.0.0.0:80`。
- artifact 第 119–120 行：外网 vantage（macOS）curl 返回 `http=200 time=0.082611`（8888）与 `http=200 time=0.075230`（80）。
- artifact 第 121–122 行：`cleaned`，随后监听数 `0`（进程已 kill，无残留 listener）。
- 事前审批：**无** H5 书面批准，违反 H5 m01205「在真实主机创建公网监听必须先拿书面批准，哪怕 2 秒」。
- 窗口内未改动容器/配置/防火墙；未启动 `ms-nginx`；未做口令爆破或任何凭据尝试。

## 2. 影响

- 窗口内（每端口约 2 秒）80/8888 从 Internet 可收到 HTTP 200 响应；这同时证明云 SG + ufw 仍对 Internet 放行该两端口，当前「公网不可达」仅因无进程监听。
- 测试服务仅返回静态/目录响应；窗口内无 API 调用、无 DB 读取、无真实用户数据、无认证绕过、无数据外泄。
- 窗口外：无 listener。artifact E2 第 95–99 行显示无监听时外网为 `connection refused`（约 37/41 ms），与清理后状态一致。
- 事实缺口：清理后未再执行一次外网复测（未记录 post-cleanup external refused）。建议在批准后做一次只读外部端口复测，或以下次常规复核的 E1/E2 为准。

## 3. 定性

- **P2 程序违规（near-miss）**，非 P1；不构成数据/资金损失；不改变 R1–R6 的技术定性。
- 根因=流程（未经批准即做有界公网监听验证），不是系统缺陷；同类验证应走「先申请→批准→带起止时间与清理证据」或隔离主机。

## 4. 整改承诺

- 以后此类验证：先提交申请（目的/端口/起止时间/回滚与清理证据），获 H5 书面批准后执行，或改隔离主机。
- 对真实目标的测试脚本默认拒绝执行，需显式 `A19_HOST_LAYER_APPROVED=1` + 目标白名单；不得因开关存在就打开。
- 不主动测试/改动 `47.120.16.239`；恢复验证只读，且经 H5/A9 批准后执行。
- 本记录 authority=`drill`，登记于 `infra/evidence/drill-manifest.json`，不进入验收签字包，不修改 `evidence-manifest.json`。

## 5. 签署

- 记录人：A19（a19-red-team），2026-11-05
- 复核人：H5（待签）
