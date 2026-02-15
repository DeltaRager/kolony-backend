alter table public.agents
add column if not exists token_hash text,
add column if not exists token_hint text,
add column if not exists token_active boolean not null default true;

create index if not exists agents_token_hash_idx on public.agents (token_hash) where token_hash is not null;
