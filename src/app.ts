import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { mcpRouter } from './routes/mcp.js';
import { operatorRouter } from './routes/operators.js';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: config.FRONTEND_ORIGIN,
      credentials: true
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'kolony-backend', timestamp: new Date().toISOString() });
  });

  app.use('/api/v1/mcp', mcpRouter);
  app.use('/api/v1', operatorRouter);

  app.use(
    (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : 'Unexpected server error';
      response.status(500).json({ error: message });
    }
  );

  return app;
}
