import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { mcpRouter } from '../../src/routes/mcp.js';
import { operatorRouter } from '../../src/routes/operators.js';

type Row = Record<string, unknown>;

const mockState = vi.hoisted(() => {
  let db: Record<string, Row[]> = {};
  let authUsersByToken: Record<string, string> = {};
  const idCounterByTable: Record<string, number> = {};

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const nextId = (table: string): number => {
    idCounterByTable[table] = (idCounterByTable[table] ?? 0) + 1;
    return idCounterByTable[table];
  };

  const nextUuid = (table: string): string => {
    const id = nextId(table).toString().padStart(12, '0');
    return `00000000-0000-0000-0000-${id}`;
  };

  class QueryBuilder implements PromiseLike<{ data: unknown; error: null | { message: string } }> {
    private filters: Array<{ column: string; value: unknown }> = [];
    private action: 'select' | 'insert' | 'update' | null = null;
    private insertPayload: Row[] = [];
    private updatePayload: Row = {};
    private expectation: 'many' | 'single' | 'maybeSingle' = 'many';
    private orderBy: { column: string; ascending: boolean } | null = null;
    private maxRows: number | null = null;

    constructor(private readonly table: string) {}

    select(_columns: string) {
      if (!this.action) this.action = 'select';
      return this;
    }

    insert(payload: Row | Row[]) {
      this.action = 'insert';
      this.insertPayload = Array.isArray(payload) ? payload : [payload];
      return this;
    }

    update(payload: Row) {
      this.action = 'update';
      this.updatePayload = payload;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push({ column, value });
      return this;
    }

    order(column: string, options?: { ascending?: boolean }) {
      this.orderBy = { column, ascending: options?.ascending ?? true };
      return this;
    }

    limit(value: number) {
      this.maxRows = value;
      return this;
    }

    single() {
      this.expectation = 'single';
      return this;
    }

    maybeSingle() {
      this.expectation = 'maybeSingle';
      return this;
    }

    private matches(row: Row) {
      return this.filters.every(({ column, value }) => row[column] === value);
    }

    private execute() {
      const rows = db[this.table] ?? [];
      let resultRows: Row[] = [];

      if (this.action === 'insert') {
        const inserted = this.insertPayload.map((item) => {
          const row: Row = clone(item);
          if (row.id === undefined) {
            row.id =
              this.table === 'command_results' || this.table === 'events'
                ? nextId(this.table)
                : nextUuid(this.table);
          }
          if (row.created_at === undefined) {
            row.created_at = new Date().toISOString();
          }
          return row;
        });
        db[this.table] = [...rows, ...inserted];
        resultRows = inserted;
      } else if (this.action === 'update') {
        resultRows = rows
          .filter((row) => this.matches(row))
          .map((row) => {
            Object.assign(row, this.updatePayload);
            return clone(row);
          });
      } else {
        resultRows = rows.filter((row) => this.matches(row)).map((row) => clone(row));
      }

      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        resultRows.sort((a, b) => {
          const left = a[column];
          const right = b[column];
          if (left === right) return 0;
          if (left === undefined || left === null) return ascending ? -1 : 1;
          if (right === undefined || right === null) return ascending ? 1 : -1;
          return left > right ? (ascending ? 1 : -1) : ascending ? -1 : 1;
        });
      }

      if (this.maxRows !== null) {
        resultRows = resultRows.slice(0, this.maxRows);
      }

      if (this.expectation === 'single') {
        if (resultRows.length !== 1) {
          return { data: null, error: { message: `Expected single row for ${this.table}` } };
        }
        return { data: resultRows[0], error: null };
      }

      if (this.expectation === 'maybeSingle') {
        if (resultRows.length > 1) {
          return { data: null, error: { message: `Expected at most one row for ${this.table}` } };
        }
        return { data: resultRows[0] ?? null, error: null };
      }

      return { data: resultRows, error: null };
    }

    then<TResult1 = { data: unknown; error: null | { message: string } }, TResult2 = never>(
      onfulfilled?:
        | ((value: { data: unknown; error: null | { message: string } }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(this.execute()).then(onfulfilled ?? undefined, onrejected ?? undefined);
    }
  }

  return {
    setDb(next: Record<string, Row[]>) {
      db = clone(next);
      Object.keys(idCounterByTable).forEach((key) => delete idCounterByTable[key]);
    },
    getDb() {
      return db;
    },
    setAuthUsers(next: Record<string, string>) {
      authUsersByToken = { ...next };
    },
    supabaseAdmin: {
      from(table: string) {
        return new QueryBuilder(table);
      }
    },
    supabaseAuthClient: {
      auth: {
        async getUser(token: string) {
          const userId = authUsersByToken[token];
          if (!userId) {
            return { data: { user: null }, error: { message: 'Invalid user token' } };
          }
          return { data: { user: { id: userId } }, error: null };
        }
      }
    }
  };
});

vi.mock('../../src/lib/supabase.js', () => ({
  supabaseAdmin: mockState.supabaseAdmin,
  supabaseAuthClient: mockState.supabaseAuthClient
}));

const OPERATOR_TOKEN = 'operator-token';
const VIEWER_TOKEN = 'viewer-token';
const AGENT_A_TOKEN = 'agent-a-token';
const AGENT_B_TOKEN = 'agent-b-token';
const USER_OPERATOR_ID = '10000000-0000-0000-0000-000000000001';
const USER_VIEWER_ID = '10000000-0000-0000-0000-000000000002';
const AGENT_A_ID = '20000000-0000-0000-0000-000000000001';
const AGENT_B_ID = '20000000-0000-0000-0000-000000000002';
const COMMAND_QUEUED_ID = '30000000-0000-0000-0000-000000000001';
const COMMAND_COMPLETED_ID = '30000000-0000-0000-0000-000000000002';

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function seedDatabase() {
  mockState.setDb({
    profiles: [
      { id: USER_OPERATOR_ID, role: 'operator' },
      { id: USER_VIEWER_ID, role: 'viewer' }
    ],
    agents: [
      {
        id: AGENT_A_ID,
        name: 'Agent A',
        external_id: 'agent-a',
        status: 'online',
        capabilities: ['echo'],
        token_hash: sha256(AGENT_A_TOKEN),
        token_active: true
      },
      {
        id: AGENT_B_ID,
        name: 'Agent B',
        external_id: 'agent-b',
        status: 'online',
        capabilities: ['echo'],
        token_hash: sha256(AGENT_B_TOKEN),
        token_active: true
      }
    ],
    commands: [
      {
        id: COMMAND_QUEUED_ID,
        agent_id: AGENT_A_ID,
        instruction: 'queued command',
        status: 'queued',
        requested_by: USER_OPERATOR_ID,
        priority: 5,
        payload: {}
      },
      {
        id: COMMAND_COMPLETED_ID,
        agent_id: AGENT_A_ID,
        instruction: 'completed command',
        status: 'completed',
        requested_by: USER_OPERATOR_ID,
        priority: 5,
        payload: {}
      }
    ],
    command_results: [],
    events: []
  });
  mockState.setAuthUsers({
    [OPERATOR_TOKEN]: USER_OPERATOR_ID,
    [VIEWER_TOKEN]: USER_VIEWER_ID
  });
}

type MockResponse = Response & {
  statusCode: number;
  body: unknown;
};

function createMockRequest(input: {
  method: string;
  path: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
}): Request {
  const headers = new Map<string, string>();
  Object.entries(input.headers ?? {}).forEach(([key, value]) => headers.set(key.toLowerCase(), value));
  return {
    method: input.method.toUpperCase(),
    originalUrl: input.path,
    url: input.path,
    path: input.path,
    params: input.params ?? {},
    body: input.body ?? {},
    query: input.query ?? {},
    header: (name: string) => headers.get(name.toLowerCase()),
    on: vi.fn()
  } as unknown as Request;
}

function createMockResponse(): MockResponse {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status: vi.fn(function (this: typeof response, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: typeof response, payload: unknown) {
      this.body = payload;
      return this;
    }),
    setHeader: vi.fn(function (this: typeof response, name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn()
  };
  return response as unknown as MockResponse;
}

async function dispatch(
  router: typeof operatorRouter | typeof mcpRouter,
  input: {
    method: string;
    path: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
  }
) {
  const req = createMockRequest(input);
  const res = createMockResponse();
  const done = new Promise<void>((resolve, reject) => {
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);
    res.json = vi.fn(((payload: unknown) => {
      const out = originalJson(payload);
      resolve();
      return out;
    }) as unknown as typeof res.json);
    res.end = vi.fn(((...args: unknown[]) => {
      const out = originalEnd(...args);
      resolve();
      return out;
    }) as unknown as typeof res.end);

    router.handle(req, res, ((error?: unknown) => (error ? reject(error) : resolve())) as NextFunction);
  });
  await done;
  return res;
}

describe('API integration', () => {
  beforeEach(() => {
    seedDatabase();
  });

  it('blocks viewers from creating commands', async () => {
    const res = await dispatch(operatorRouter, {
      method: 'POST',
      path: '/commands',
      body: { agentId: AGENT_A_ID, instruction: 'run diagnostics' },
      headers: { authorization: `Bearer ${VIEWER_TOKEN}` }
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient role' });
  });

  it('allows operators to create commands and writes audit event', async () => {
    const res = await dispatch(operatorRouter, {
      method: 'POST',
      path: '/commands',
      body: { agentId: AGENT_A_ID, instruction: 'run diagnostics' },
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });

    expect(res.statusCode).toBe(201);
    expect((res.body as { data: { status: string } }).data.status).toBe('queued');

    const db = mockState.getDb();
    const createdEvent = (db.events ?? []).find((row) => row.event_type === 'command.created');
    expect(createdEvent).toBeTruthy();
  });

  it('rejects cancel when command lifecycle transition is invalid', async () => {
    const res = await dispatch(operatorRouter, {
      method: 'POST',
      path: `/commands/${COMMAND_COMPLETED_ID}/cancel`,
      params: { id: COMMAND_COMPLETED_ID },
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Invalid status transition' });
  });

  it('accepts MCP heartbeat with agent token', async () => {
    const res = await dispatch(mcpRouter, {
      method: 'POST',
      path: '/agents/heartbeat',
      body: { status: 'online' },
      headers: { authorization: `Bearer ${AGENT_A_TOKEN}` }
    });

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { id: string; status: string } }).data.id).toBe(AGENT_A_ID);
    expect((res.body as { data: { id: string; status: string } }).data.status).toBe('online');
  });

  it('rejects invalid MCP transition queued -> executing', async () => {
    const res = await dispatch(mcpRouter, {
      method: 'POST',
      path: `/commands/${COMMAND_QUEUED_ID}/progress`,
      params: { id: COMMAND_QUEUED_ID },
      body: { status: 'executing' },
      headers: { authorization: `Bearer ${AGENT_A_TOKEN}` }
    });

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain('Invalid status transition queued -> executing');
  });

  it('rejects MCP updates for commands owned by a different agent', async () => {
    const res = await dispatch(mcpRouter, {
      method: 'POST',
      path: `/commands/${COMMAND_QUEUED_ID}/progress`,
      params: { id: COMMAND_QUEUED_ID },
      body: { status: 'dispatching' },
      headers: { authorization: `Bearer ${AGENT_B_TOKEN}` }
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Command does not belong to agent' });
  });

  it('supports command stream endpoint handshake', async () => {
    const req = createMockRequest({
      method: 'GET',
      path: `/commands/${COMMAND_QUEUED_ID}/stream`,
      params: { id: COMMAND_QUEUED_ID },
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });
    const closeEmitter = new EventEmitter();
    (req.on as unknown as ReturnType<typeof vi.fn>).mockImplementation((event: string, cb: () => void) => {
      closeEmitter.on(event, cb);
      return req;
    });

    const res = createMockResponse();
    await new Promise<void>((resolve, reject) => {
      operatorRouter.handle(req, res, ((error?: unknown) => (error ? reject(error) : resolve())) as NextFunction);
      setImmediate(resolve);
    });

    expect(res.setHeader).toHaveBeenCalledTimes(3);
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalled();

    closeEmitter.emit('close');
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
