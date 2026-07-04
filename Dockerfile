# ─────────────────────────────────────────────
# Stage 1: builder
# Install all dependencies and compile TypeScript
# ─────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package.json package-lock.json* ./
RUN npm ci

# Copy Prisma schema before generating client
COPY prisma/ ./prisma/
RUN npx prisma generate

# Copy source and compile
COPY . .
RUN npm run build

# ─────────────────────────────────────────────
# Stage 2: production
# Minimal runtime — only compiled output and prod deps
# ─────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Add non-root user before copying files
RUN addgroup -S nestjs && adduser -S nestjs -G nestjs -u 1001

# Copy only what runtime needs
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Switch to non-root user
USER nestjs

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "dist/main"]
