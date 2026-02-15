import { describe, expect, it } from 'vitest';
import { canTransition } from '../../src/lib/lifecycle.js';

describe('canTransition', () => {
  it('allows valid lifecycle transitions', () => {
    expect(canTransition('draft', 'queued')).toBe(true);
    expect(canTransition('queued', 'dispatching')).toBe(true);
    expect(canTransition('dispatching', 'executing')).toBe(true);
    expect(canTransition('executing', 'completed')).toBe(true);
    expect(canTransition('executing', 'failed')).toBe(true);
    expect(canTransition('executing', 'cancelled')).toBe(true);
  });

  it('allows repeated executing updates', () => {
    expect(canTransition('executing', 'executing')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('draft', 'executing')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
  });
});
