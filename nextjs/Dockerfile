# =============================================================================
# Next.js Production Dockerfile
# Multi-stage build for optimized production image
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# Install all dependencies (including devDependencies for build)
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# Install dependencies required for native modules
RUN apk add --no-cache libc6-compat

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies (npm cache mount reuses downloads across builds)
RUN --mount=type=cache,target=/root/.npm \
  npm ci

# -----------------------------------------------------------------------------
# Stage 2: Builder
# Build the Next.js application
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Accept build arguments for NEXT_PUBLIC_* variables
ARG NEXT_PUBLIC_PRODUCT_NAME=dbt-craft

# Set environment variables for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV NEXT_PUBLIC_PRODUCT_NAME=${NEXT_PUBLIC_PRODUCT_NAME}

# Copy only prisma schema first (changes less often)
COPY prisma ./prisma
RUN npx prisma generate

# Copy remaining source code
COPY . .

# Create .next/cache directory before build (required by webpack)
RUN mkdir -p /app/.next/cache

# Build the application
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: Runner (Production)
# Minimal image to run the production build
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

# Runtime does not need npm/yarn/corepack. Remove their dependency trees so
# package-manager CVEs cannot ship in the production image, and apply only the
# available security update for the Alpine TLS libraries.
RUN apk upgrade --no-cache libcrypto3 libssl3 && \
  rm -rf /usr/local/lib/node_modules /opt/yarn-v* && \
  rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone build and static files
# Next.js outputs standalone build which includes only necessary files
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Set hostname to listen on all interfaces
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Start the production server
CMD ["node", "server.js"]
