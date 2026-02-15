import type { CommandStatus } from '../types.js';

const transitions: Record<CommandStatus, CommandStatus[]> = {
  draft: ['queued'],
  queued: ['dispatching', 'cancelled', 'failed'],
  dispatching: ['executing', 'failed', 'cancelled'],
  executing: ['executing', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
};

export function canTransition(from: CommandStatus, to: CommandStatus): boolean {
  if (from === to && to === 'executing') {
    return true;
  }
  return transitions[from].includes(to);
}
