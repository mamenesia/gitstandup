# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app

# Copy lockfile and manifest for deterministic install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional

# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js telemetry off during build.
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time env: Next reads public vars only. Secrets are injected at runtime.
RUN npm run build

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Prefer IPv4 for DNS — avoids NAT64/IPv6 TLS issues with some providers.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Non-root user for security.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy the standalone server output (.next/standalone) + static assets.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
