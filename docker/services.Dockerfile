# Container images for the API and the worker (Stage 07). Build from the repository root:
#
#   docker build -f docker/services.Dockerfile --target api -t chaanavya-api .
#   docker build -f docker/services.Dockerfile --target worker -t chaanavya-worker .
#
# The web host stays on Vercel. Images carry no configuration: DATABASE_URL, BETTER_AUTH_SECRET,
# API_INTERNAL_KEY and the rest come from the hosting secret store at run time (docs/ENVIRONMENT.md).
# Migrations are a separate release step (`npm run db:migrate`), never run on container start.

FROM node:24.21.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
# prisma generate runs on install and needs the schema and config.
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npm run build:api && npm run --workspace @chaanavya/worker typecheck
# Drop build-only packages (TypeScript, the Next.js toolchain) from what the runtime copies.
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.21.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages packages
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/src apps/api/src
WORKDIR /app/apps/api
ENV API_PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/src apps/api/src
COPY --from=build --chown=node:node /app/apps/worker apps/worker
WORKDIR /app/apps/worker
ENV WORKER_HEALTH_PORT=4001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.WORKER_HEALTH_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "src/main.ts"]
