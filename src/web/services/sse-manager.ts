import { randomUUID } from 'crypto';

interface SSEClient {
  id: string;
  channel: string;
  controller: ReadableStreamDefaultController;
}

class SSEManager {
  private clients: SSEClient[] = [];

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
  }

  /** Get count of connected clients for a channel */
  getClientCount(channel: string): number {
    return this.clients.filter(c => c.channel === channel).length;
  }
}

export const sseManager = new SSEManager();
