#!/bin/bash
# Railway startup script: seed data if volumes are empty

# Seed SQLite DB if volume is empty
if [ ! -f /app/data/scraper.db ] && [ -f /app/seed/scraper.db ]; then
  echo "[Seed] Copying initial database to volume..."
  cp /app/seed/scraper.db /app/data/scraper.db
  echo "[Seed] Database seeded successfully."
fi

# Seed cookies if volume is empty
if [ ! -d /app/cookies/instagram ] && [ -d /app/seed/cookies ]; then
  echo "[Seed] Copying initial cookies to volume..."
  cp -r /app/seed/cookies/* /app/cookies/
  echo "[Seed] Cookies seeded successfully."
fi

# Start the server
exec node --max-http-header-size=65536 --import tsx/esm src/web/server.ts
