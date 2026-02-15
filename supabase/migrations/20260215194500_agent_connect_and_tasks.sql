create table if not exists public.agent_connect_intents (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  setup_code_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint agent_connect_intents_expires_after_create check (expires_at > created_at)
);

create index if not exists agent_connect_intents_expires_idx
  on public.agent_connect_intents (expires_at)
  where consumed_at is null;

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  external_task_id text not null,
  title text not null,
  status text not null,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint agent_tasks_status_valid check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  constraint agent_tasks_title_not_blank check (length(trim(title)) > 0),
  constraint agent_tasks_external_id_not_blank check (length(trim(external_task_id)) > 0),
  unique (agent_id, external_task_id)
);

create index if not exists agent_tasks_agent_status_idx on public.agent_tasks (agent_id, status);
create index if not exists agent_tasks_agent_updated_at_idx on public.agent_tasks (agent_id, updated_at desc);

create trigger set_agent_tasks_updated_at
before update on public.agent_tasks
for each row execute function public.set_updated_at();

create table if not exists public.agent_task_logs (
  id bigserial primary key,
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  seq bigint not null,
  ts timestamptz not null default now(),
  level text not null default 'info',
  line text not null,
  created_at timestamptz not null default now(),
  constraint agent_task_logs_level_valid check (level in ('debug', 'info', 'warn', 'error')),
  constraint agent_task_logs_line_not_blank check (length(trim(line)) > 0),
  unique (task_id, seq)
);

create index if not exists agent_task_logs_task_seq_idx on public.agent_task_logs (task_id, seq);
create index if not exists agent_task_logs_task_created_idx on public.agent_task_logs (task_id, created_at);

alter table public.agent_connect_intents enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_task_logs enable row level security;

create policy "agent_connect_intents_read_authenticated"
on public.agent_connect_intents
for select
using (auth.role() = 'authenticated');

create policy "agent_tasks_read_authenticated"
on public.agent_tasks
for select
using (auth.role() = 'authenticated');

create policy "agent_task_logs_read_authenticated"
on public.agent_task_logs
for select
using (auth.role() = 'authenticated');

create policy "agent_connect_intents_write_operator_admin"
on public.agent_connect_intents
for all
using (public.current_app_role() in ('operator', 'admin'))
with check (public.current_app_role() in ('operator', 'admin'));

create policy "agent_tasks_write_operator_admin"
on public.agent_tasks
for all
using (public.current_app_role() in ('operator', 'admin'))
with check (public.current_app_role() in ('operator', 'admin'));

create policy "agent_task_logs_write_operator_admin"
on public.agent_task_logs
for all
using (public.current_app_role() in ('operator', 'admin'))
with check (public.current_app_role() in ('operator', 'admin'));
