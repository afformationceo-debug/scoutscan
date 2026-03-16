#!/bin/bash
set -e

echo "[Start] ScoutScan starting..."

# Seed SQLite DB if volume is empty
if [ ! -f /app/data/scraper.db ] && [ -f /app/seed/scraper.db ]; then
  echo "[Seed] Copying initial database to volume..."
  cp /app/seed/scraper.db /app/data/scraper.db
  echo "[Seed] Database seeded."
fi

# Create cookies dir inside data volume (persistent)
mkdir -p /app/data/cookies/instagram

# Seed cookies if not yet present
if [ ! -f /app/data/cookies/instagram.json ] && [ -f /app/seed/cookies/instagram.json ]; then
  echo "[Seed] Copying initial cookies..."
  cp -r /app/seed/cookies/* /app/data/cookies/
  echo "[Seed] Cookies seeded."
fi

# Symlink cookies dir so the app finds them at /app/cookies
ln -sfn /app/data/cookies /app/cookies

# Auto-migrate CSV seed data (campaigns + keywords) into DB
if [ ! -f /app/data/.seed-migrated ]; then
  echo "[Start] Running seed migration..."
  node --import tsx/esm src/seed-migrate.ts || echo "[Start] Seed migration failed (non-fatal)"
fi

echo "[Start] Launching server..."
exec node --max-http-header-size=65536 --import tsx/esm src/web/server.ts
