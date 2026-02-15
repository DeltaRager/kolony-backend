import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { AgentRequest } from '../../src/middleware/agent-auth.js';

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn()
}));

vi.mock('../../src/lib/supabase.js', () => ({
  supabaseAdmin: {
    from: fromMock
  }
}));

import { requireAgent } from '../../src/middleware/agent-auth.js';

function mockResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn()
  } as unknown as Response;
  (response.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(response);
  (response.json as unknown as ReturnType<typeof vi.fn>).mockReturnValue(response);
  return response;
}

describe('requireAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when bearer token is missing', async () => {
    const request = {
      header: vi.fn().mockReturnValue(undefined)
    } as unknown as AgentRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    await requireAgent(request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Missing agent token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token does not match an active agent', async () => {
    const request = {
      header: vi.fn().mockReturnValue('Bearer bad-token')
    } as unknown as AgentRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    const queryBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn()
    };
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.eq.mockReturnValue(queryBuilder);
    queryBuilder.maybeSingle.mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue(queryBuilder);

    await requireAgent(request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Invalid agent token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches agent metadata when token is valid', async () => {
    const request = {
      header: vi.fn().mockReturnValue('Bearer good-token')
    } as unknown as AgentRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    const queryBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn()
    };
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.eq.mockReturnValue(queryBuilder);
    queryBuilder.maybeSingle.mockResolvedValue({
      data: { id: 'agent-1', external_id: 'external-1' },
      error: null
    });
    fromMock.mockReturnValue(queryBuilder);

    await requireAgent(request, response, next);

    expect(request.agentId).toBe('agent-1');
    expect(request.externalId).toBe('external-1');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
