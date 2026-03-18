import { randomUUID } from 'crypto';

interface SSEClient {
  id: string;
  channel: string;
  controller: ReadableStreamDefaultController;
}

// Events that should be persisted to DB as notifications
const PERSIST_EVENTS = new Set([
  'scraping_started', 'scraping_completed',
  'dm_sent', 'dm_failed', 'dm_processing',
  'campaign_completed',
  'cookie_warning', 'cookie_expired',
  'auto_assign',
  'account_blocked', 'send_failed',
]);

class SSEManager {
  private clients: SSEClient[] = [];
  private _insertStmt: any = null;
  private _dbRef: any = null;

  /** Set DB reference (called once from server.ts after DB init) */
  setDb(db: any) {
    this._dbRef = db;
    try {
      this._insertStmt = db.prepare(
        'INSERT INTO notifications (type, message, detail, created_at) VALUES (?, ?, ?, ?)'
      );
    } catch { /* table may not exist yet */ }
  }

  /** Add a client to a channel */
  addClient(channel: string, controller: ReadableStreamDefaultController): string {
    const id = randomUUID();
    this.clients.push({ id, channel, controller });
    return id;
  }

  /** Remove a client */
  removeClient(clientId: string): void {
    this.clients = this.clients.filter(c => c.id !== clientId);
  }

  /** Broadcast an event to all clients on a channel */
  broadcast(channel: string, event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = new TextEncoder().encode(payload);
    const channelClients = this.clients.filter(c => c.channel === channel);

    for (const client of channelClients) {
      try {
        client.controller.enqueue(encoded);
      } catch {
        this.removeClient(client.id);
      }
    }

    // Persist important events to DB
    if (channel === 'global' && PERSIST_EVENTS.has(event)) {
      try {
        const stmt = this._insertStmt;
        if (stmt) {
          const message = data.message || this.buildMessage(event, data);
          const detail = data.detail || data.error || '';
          stmt.run(event, message, detail, new Date().toISOString());
        }
      } catch { /* don't break SSE if DB fails */ }
    }
  }

  /** Build human-readable message from event data */
  private buildMessage(event: string, data: any): string {
    switch (event) {
      case 'scraping_started': return `스크래핑 시작: ${data.keyword || ''} (${data.platform || ''})`;
      case 'scraping_completed': return `스크래핑 완료: ${data.postsCount || 0}P, ${data.profilesCount || 0}명`;
      case 'dm_sent': return `DM 발송 성공: @${data.recipient} (${data.campaign || data.platform})`;
      case 'dm_failed': return `DM 발송 실패: @${data.recipient} (${data.campaign || data.platform})`;
      case 'dm_processing': return `DM 처리중: @${data.recipient}`;
      case 'campaign_completed': return `캠페인 완료: ${data.campaignName} (발송 ${data.sent}, 실패 ${data.failed})`;
      case 'cookie_warning': return data.isScraping ? `[스크래핑] ${data.platform} 쿠키 만료 임박` : `[DM] ${(data.campaignNames || []).join(', ') || '@' + data.username} 쿠키 만료 임박`;
      case 'cookie_expired': return data.isScraping ? `[스크래핑] ${data.platform} 쿠키 만료됨` : `[DM] ${(data.campaignNames || []).join(', ') || '@' + data.username} 쿠키 만료됨`;
      case 'auto_assign': return `캠페인 자동 배정: ${data.assigned || 0}명`;
      case 'account_blocked': return `계정 차단: @${data.account}`;
      case 'send_failed': return `발송 실패: @${data.recipient}`;
      default: return event;
    }
  }

  /** Get count of connected clients for a channel */
  getClientCount(channel: string): number {
    return this.clients.filter(c => c.channel === channel).length;
  }
}

export const sseManager = new SSEManager();
