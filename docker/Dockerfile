# ─── Builder stage ───
FROM node:22-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* ./

# Install dependencies (prefer npm ci; fall back to npm install)
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable && pnpm install --frozen-lockfile; \
    else \
      npm install; \
    fi

COPY tsconfig.json ./
COPY src ./src
COPY packages ./packages
COPY ui ./ui

RUN npm run build:api
RUN npm run build:ui

# ─── Runtime stage ───
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* ./

# Install production dependencies only
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable && pnpm install --frozen-lockfile --prod; \
    else \
      npm install --omit=dev; \
    fi

# Copy compiled output from builder and verify UI assets exist
COPY --from=builder /app/dist ./dist
RUN test -f ./dist/ui/index.html || (echo "ERROR: UI build output missing" && exit 1)

# Install curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create directories for state and skills
RUN mkdir -p /data /skills && chown -R node:node /app /data /skills

# Security: run as non-root
USER node

ENV NODE_ENV=production
ENV FRIDAY_STATE_DIR=/data
ENV FRIDAY_SKILLS_DIR=/skills
ENV FRIDAY_HOST=0.0.0.0
ENV FRIDAY_PORT=3141

EXPOSE 3141

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3141/v1/health || exit 1

CMD ["node", "dist/cli/friday-cli.js", "start"]
