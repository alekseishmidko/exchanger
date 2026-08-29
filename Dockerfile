FROM node:22-alpine AS base

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY apps/backend apps/backend
COPY packages/contracts packages/contracts

FROM base AS development
CMD ["pnpm", "--filter", "@exchange/backend", "start:dev"]

FROM base AS build
RUN pnpm build

FROM node:22-alpine AS production
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build /workspace/apps/backend/dist ./apps/backend/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
CMD ["node", "apps/backend/dist/main.js"]
