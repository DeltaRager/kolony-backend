import type { Response } from 'express';

type StreamClient = {
  response: Response;
};

type StreamPayload = {
  commandId: string;
  status?: string;
  result?: string;
  isFinal?: boolean;
  eventType: string;
  timestamp: string;
  data?: Record<string, unknown>;
};

class RealtimeHub {
  private clientsByCommand = new Map<string, Set<StreamClient>>();

  subscribe(commandId: string, response: Response): () => void {
    const existing = this.clientsByCommand.get(commandId) ?? new Set<StreamClient>();
    const client = { response };
    existing.add(client);
    this.clientsByCommand.set(commandId, existing);

    return () => {
      const clients = this.clientsByCommand.get(commandId);
      if (!clients) return;
      clients.delete(client);
      if (clients.size === 0) this.clientsByCommand.delete(commandId);
    };
  }

  publish(commandId: string, payload: StreamPayload): void {
    const clients = this.clientsByCommand.get(commandId);
    if (!clients) return;

    const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
    clients.forEach((client) => client.response.write(data));
  }
}

export const realtimeHub = new RealtimeHub();
