# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 1. Build the frontend and compile the server
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install exactly what the lockfile pins; skip dev scripts for a faster, safer build.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.base.json tsconfig.json tsconfig.build.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY data ./data

# Type-check both projects, then emit the SPA (dist/) and the server (dist-server/).
RUN npm run typecheck && npm run build && npm run build:server

# ---------------------------------------------------------------------------
# 2. Runtime: only production dependencies and the compiled output
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    IDOL_DATA_DIR=/app/.data

# Runtime dependencies only (express, marked, dompurify, highlight.js).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/data ./data
COPY huggingface ./huggingface

# The index and any encrypted GitHub token live here. Mount a volume to keep
# them across restarts; the app rebuilds the index from scratch if it is empty.
RUN mkdir -p /app/.data && chown -R node:node /app/.data

# Never run as root.
USER node

EXPOSE 8787

# The health endpoint is unauthenticated and cheap: it only reports liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist-server/server/index.js"]
