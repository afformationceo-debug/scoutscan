FROM node:20-slim

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libgtk-3-0 libasound2 libxshmfence1 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2 \
    libatspi2.0-0 libxfixes3 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npx playwright install chromium && \
    npm install tsx && \
    npm cache clean --force

# Copy source
COPY src/ ./src/
COPY tsconfig.json CLAUDE.md start.sh ./
COPY seed/ ./seed/

# Create directories
RUN mkdir -p data cookies/instagram && chmod +x start.sh

EXPOSE 3000

CMD ["bash", "start.sh"]
