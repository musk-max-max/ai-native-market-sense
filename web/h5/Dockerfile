# web/h5 生产镜像：多阶段构建，构建上下文 = 仓库根（见 tests/e2e/docker-compose.yml）。
#
# 为什么从仓库根构建：web/h5 依赖 workspace 包 @market-sense/api-client（契约生成的类型化客户端）。
# 只 COPY 需要的 workspace 成员，避免把根 node_modules（数百 MB）带进构建上下文；
# 若后续新增 h5 依赖的 workspace 包，需要同步增加 COPY 行。
FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY web/h5/package.json ./web/h5/package.json

# 只安装 h5 及其依赖（api-client）。--frozen-lockfile 保证与仓库 lockfile 一致。
RUN pnpm install --frozen-lockfile --filter @market-sense/h5...

COPY packages/api-client ./packages/api-client
COPY web/h5 ./web/h5

# ADR-006 D3 的文案快照门禁（copy-snapshot.mjs --check）在构建期读仓库内的快照与 manifest，
# 它们既不是 web/h5 的源码、也不来自 node_modules；上面的精确 COPY 不会带进来。
# 只送这两个只读证据文件，不扩大上下文（docs 其余内容与构建无关）。
COPY docs/release/copy-snapshots ./docs/release/copy-snapshots
COPY docs/release/copy-version-manifest.md ./docs/release/copy-version-manifest.md

ARG VITE_DATA_MODE=api
ARG VITE_API_BASE_URL=
ARG VITE_E2E_AUTH_STORAGE_KEY=
ENV VITE_DATA_MODE=${VITE_DATA_MODE} \
    VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_E2E_AUTH_STORAGE_KEY=${VITE_E2E_AUTH_STORAGE_KEY}

RUN pnpm --filter @market-sense/h5 build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=build --chown=node:node /repo/web/h5/dist ./dist
COPY --chown=node:node web/h5/server.mjs ./server.mjs

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
