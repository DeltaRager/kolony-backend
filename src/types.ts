export type AppRole = 'viewer' | 'operator' | 'admin';

export type CommandStatus =
  | 'draft'
  | 'queued'
  | 'dispatching'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentStatus = 'online' | 'offline' | 'busy' | 'error';

export type AgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
