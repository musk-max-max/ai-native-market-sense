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
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @market-sense/api build
RUN pnpm --filter @market-sense/api deploy --prod /app/deploy

# ---- runtime：仅 deploy 产物（dist + 生产 node_modules + package.json）；非 root ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/deploy ./
# deploy 会带上源码/测试/tsconfig（package 内容），运行时只需要 dist + package.json + node_modules。
RUN rm -rf src test scripts tsconfig.json tsconfig.build.json README.md

USER node
EXPOSE 8080

# P0 就绪探针：进程活着 + 外壳能响应 /healthz（数据是否进来由域插件 health 贡献字段判断）。
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/services/api/src/server.js"]
