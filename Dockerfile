# ═══════════════════════════════════════════════════════════════
#  SocialCall Backend — Docker Image for Google Cloud Run
#  Multi-stage build: keeps final image small (~150MB)
# ═══════════════════════════════════════════════════════════════

# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:18-alpine AS deps
WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm ci --only=production --ignore-scripts && \
    npm cache clean --force

# ── Stage 2: Final image ────────────────────────────────────────
FROM node:18-alpine AS runner
WORKDIR /app

# Add non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nodeuser

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --chown=nodeuser:nodejs . .

# Create uploads directory
RUN mkdir -p uploads && chown nodeuser:nodejs uploads

# Switch to non-root user
USER nodeuser

# Cloud Run sets PORT to 8080 — our server reads process.env.PORT
EXPOSE 8080

# Health check (Cloud Run uses this)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

# Start the server
CMD ["node", "server.js"]
