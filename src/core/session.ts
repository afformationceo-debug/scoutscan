import { randomUUID } from 'crypto';
import { SessionData } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Session Manager - Manages browser sessions with cookie persistence
 * Handles session rotation, aging, and health tracking
 */
export class SessionManager {
  private sessions = new Map<string, SessionData>();
  private maxSessionAge = 30 * 60 * 1000; // 30 minutes
  private maxRequestsPerSession = 50;

  /** Create a new session */
  createSession(userAgent: string): SessionData {
    const session: SessionData = {
      id: randomUUID(),
      cookies: {},
      userAgent,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      requestCount: 0,
      isBlocked: false,
    };

    this.sessions.set(session.id, session);
    logger.debug(`Session created: ${session.id.slice(0, 8)}`);
    return session;
  }

  /** Get a healthy session or create new one */
  getSession(userAgent: string): SessionData {
    // Find an existing healthy session
    for (const session of this.sessions.values()) {
      if (this.isHealthy(session)) {
        session.lastUsedAt = Date.now();
        return session;
      }
    }

    // All sessions exhausted, create new one
    return this.createSession(userAgent);
  }

  /** Update session cookies */
  updateCookies(sessionId: string, cookies: Record<string, string>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cookies = { ...session.cookies, ...cookies };
    }
  }

  /** Record a request for the session */
  recordRequest(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.requestCount++;
      session.lastUsedAt = Date.now();
    }
  }

  /** Mark session as blocked */
  markBlocked(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isBlocked = true;
      logger.warn(`Session blocked: ${sessionId.slice(0, 8)}`);
    }
  }

  /** Check if a session is still usable */
  private isHealthy(session: SessionData): boolean {
    if (session.isBlocked) return false;
    if (Date.now() - session.createdAt > this.maxSessionAge) return false;
    if (session.requestCount >= this.maxRequestsPerSession) return false;
    return true;
  }

  /** Clean up expired sessions */
  cleanup(): void {
    for (const [id, session] of this.sessions.entries()) {
      if (!this.isHealthy(session)) {
        this.sessions.delete(id);
      }
    }
  }

  get activeSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (this.isHealthy(session)) count++;
    }
    return count;
  }
}
