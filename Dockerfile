FROM node:20-slim

# Install Playwright system dependencies + Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libgtk-3-0 libasound2 libxshmfence1 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2 \
    libatspi2.0-0 libxfixes3 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npx playwright install chromium && \
    npm cache clean --force

# Install tsx for running TypeScript directly
RUN npm install tsx

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./
COPY CLAUDE.md ./

# Create data and cookies directories
RUN mkdir -p data cookies/instagram

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start server
CMD ["node", "--max-http-header-size=65536", "--import", "tsx/esm", "src/web/server.ts"]
