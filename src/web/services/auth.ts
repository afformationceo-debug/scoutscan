import { db } from './db.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// ─── Schema ───

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// ─── User Management ───

export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export function createUser(email: string, password: string, name?: string): User {
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase(), passwordHash, name || null, now);

  return { id, email: email.toLowerCase(), name: name || null, createdAt: now, lastLoginAt: null };
}

export function authenticateUser(email: string, password: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as any;
  if (!row) return null;

  if (!bcrypt.compareSync(password, row.password_hash)) return null;

  // Update last login
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    lastLoginAt: new Date().toISOString(),
  };
}

export function getUserById(id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function getUserCount(): number {
  return (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
}

// ─── Session Management ───

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createSession(userId: string): string {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).run(sessionId, userId, expiresAt.toISOString(), now.toISOString());

  // Cleanup old sessions for this user (keep max 5)
  db.prepare(`
    DELETE FROM sessions WHERE user_id = ? AND id NOT IN (
      SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
    )
  `).run(userId, userId);

  return sessionId;
}

export function validateSession(sessionId: string): User | null {
  if (!sessionId) return null;

  const row = db.prepare(`
    SELECT s.*, u.id as uid, u.email, u.name, u.created_at as user_created_at, u.last_login_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sessionId, new Date().toISOString()) as any;

  if (!row) return null;

  return {
    id: row.uid,
    email: row.email,
    name: row.name,
    createdAt: row.user_created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function deleteSession(sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ─── Seed initial user + migrate data ───

export function seedInitialUser(): void {
  const count = getUserCount();
  if (count > 0) return; // Already seeded

  console.log('[Auth] Creating initial user...');
  const user = createUser('afformation.ceo@gmail.com', 'afformation1!', 'Admin');

  // Migrate all existing data to this user
  migrateExistingDataToUser(user.id);
  console.log(`[Auth] Initial user created: ${user.email} (${user.id})`);
}

function migrateExistingDataToUser(userId: string): void {
  const tables = [
    'jobs', 'posts', 'profiles', 'keyword_targets', 'influencer_master',
    'dm_campaigns', 'dm_action_queue', 'dm_accounts', 'comment_templates',
    'dm_engagement_log', 'dm_rounds', 'scraping_cookies',
  ];

  for (const table of tables) {
    try {
      // Check if user_id column exists
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      const hasUserId = cols.some((c: any) => c.name === 'user_id');

      if (!hasUserId) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
      }

      // Assign all existing rows to this user
      const result = db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(userId);
      if (result.changes > 0) {
        console.log(`[Auth] Migrated ${result.changes} rows in ${table} to user ${userId}`);
      }
    } catch (e: any) {
      // Column might already exist
      if (!e.message?.includes('duplicate column')) {
        console.error(`[Auth] Error migrating ${table}:`, e.message);
      }
    }
  }

  // Create indexes for user_id on main tables
  const indexTables = ['jobs', 'posts', 'profiles', 'keyword_targets', 'influencer_master', 'dm_campaigns'];
  for (const table of indexTables) {
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user_id ON ${table}(user_id)`);
    } catch { /* ignore */ }
  }
}
