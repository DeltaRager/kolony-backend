import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../src/middleware/user-auth.js';

const { getUserMock, fromMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  fromMock: vi.fn()
}));

vi.mock('../../src/lib/supabase.js', () => ({
  supabaseAuthClient: {
    auth: {
      getUser: getUserMock
    }
  },
  supabaseAdmin: {
    from: fromMock
  }
}));

import { requireRole, requireUser } from '../../src/middleware/user-auth.js';

function mockResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn()
  } as unknown as Response;
  (response.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(response);
  (response.json as unknown as ReturnType<typeof vi.fn>).mockReturnValue(response);
  return response;
}

describe('requireUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when bearer token is missing', async () => {
    const request = {
      header: vi.fn().mockReturnValue(undefined),
      query: {}
    } as unknown as AuthenticatedRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    await requireUser(request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Missing bearer token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', async () => {
    const request = {
      header: vi.fn().mockReturnValue('Bearer invalid'),
      query: {}
    } as unknown as AuthenticatedRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('bad token') });

    await requireUser(request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Invalid user token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('sets user and defaults role to viewer when profile is absent', async () => {
    const request = {
      header: vi.fn().mockReturnValue('Bearer token-123'),
      query: {}
    } as unknown as AuthenticatedRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null
    });

    const queryBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn()
    };
    queryBuilder.select.mockReturnValue(queryBuilder);
    queryBuilder.eq.mockReturnValue(queryBuilder);
    queryBuilder.maybeSingle.mockResolvedValue({
      data: null,
      error: null
    });
    fromMock.mockReturnValue(queryBuilder);

    await requireUser(request, response, next);

    expect(request.userId).toBe('user-1');
    expect(request.role).toBe('viewer');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireRole', () => {
  it('returns 403 when current role is lower than required', () => {
    const middleware = requireRole('operator');
    const request = { role: 'viewer' } as unknown as AuthenticatedRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: 'Insufficient role' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when user has sufficient role', () => {
    const middleware = requireRole('operator');
    const request = { role: 'admin' } as unknown as AuthenticatedRequest;
    const response = mockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
