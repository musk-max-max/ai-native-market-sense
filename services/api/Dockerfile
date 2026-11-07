# services/api 生产镜像：多阶段构建，构建上下文 = 仓库根（tests/e2e/docker-compose.yml: api.build.context=../..）。
#
# 为什么从仓库根构建：services/api 的 TS 构建会把同仓库的 services/market 源码一起编译进
# dist（P0 域插件是源码级组合，见 ADR-001 D7 / services/api/tsconfig.build.json），
# 因此不能只 COPY services/api 单目录，也不能只装 api 自己的依赖（编译产物运行期需要 pg / fastify）。
#
# 阶段：build（完整 workspace + tsc + pnpm deploy --prod）→ runtime（deploy 产物，非 root）。
# 本机无 docker，镜像内命令以仓库内等价命令验证（见 docs/adr/ADR-006 附注 / 交付说明）。

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

# ---- build：完整安装 + tsc 构建 + 生产依赖部署（pnpm deploy 会生成独立 node_modules）----
FROM base AS build
COPY . .
# L70：prod 的 entitlement 事件写入前按 docs/reference/event-payloads.json 做键集 fail-closed 校验。
# 该文件不在 pnpm deploy 产物里，必须在构建期断言存在且可解析——镜像里缺文件/坏 JSON
# 应当是 docker build 失败，而不是容器起来后进程拒启（Lead m01809 / A3 m01900）。
RUN node -e "const fs=require('fs');const p='docs/reference/event-payloads.json';if(!fs.existsSync(p))throw new Error('missing '+p);const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.schema_version!==1||typeof j.event_types!=='object'||j.event_types===null)throw new Error('invalid '+p);console.log('event-payloads contract OK')"
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @market-sense/api build
RUN pnpm --filter @market-sense/api deploy --prod /app/deploy

# ---- runtime：仅 deploy 产物（dist + 生产 node_modules + package.json）；非 root ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    EVENT_PAYLOADS_PATH=/app/docs/reference/event-payloads.json
WORKDIR /app

COPY --from=build --chown=node:node /app/deploy ./
# deploy 会带上源码/测试/tsconfig（package 内容），运行时只需要 dist + package.json + node_modules。
RUN rm -rf src test scripts tsconfig.json tsconfig.build.json README.md
# 契约是运行时 fail-closed 依赖，不是文档：固定路径 + 镜像内构建期断言。
COPY --from=build --chown=node:node /app/docs/reference/event-payloads.json /app/docs/reference/event-payloads.json
# L161：AI 内容策略单一真源（fail-closed 加载，缺文件应 docker build 失败而非运行时拒启）。
# compliance/src/ai-content-policy.ts resolveRepoRoot = /app/dist，找 /app/dist/rules/ai-content-policy.json。
COPY --from=build --chown=node:node /app/rules/ai-content-policy.json /app/dist/rules/ai-content-policy.json
COPY --from=build --chown=node:node /app/rules/redline-basis.json /app/dist/rules/redline-basis.json
RUN node -e "const fs=require('fs');const p='/app/docs/reference/event-payloads.json';if(!fs.existsSync(p))throw new Error('missing '+p);const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.schema_version!==1||typeof j.event_types!=='object'||j.event_types===null)throw new Error('invalid '+p);console.log('event-payloads contract present')"

USER node
EXPOSE 8080

# P0 就绪探针：进程活着 + 外壳能响应 /healthz（数据是否进来由域插件 health 贡献字段判断）。
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/services/api/src/server.js"]
