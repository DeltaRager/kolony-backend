alter table public.commands
add column if not exists claimed_by_agent_id uuid references public.agents(id) on delete set null,
add column if not exists claimed_at timestamptz,
add column if not exists lease_expires_at timestamptz,
add column if not exists attempt_count integer not null default 0,
add column if not exists last_claim_error text;

create index if not exists commands_claimable_idx
  on public.commands (status, lease_expires_at, created_at)
  where status = 'queued'::public.command_status;

create index if not exists commands_claimed_by_status_idx
  on public.commands (claimed_by_agent_id, status)
  where claimed_by_agent_id is not null;

create or replace function public.claim_agent_commands(
  p_agent_id uuid,
  p_max_claims integer default 1,
  p_lease_seconds integer default 60
)
returns setof public.commands
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_limit integer := greatest(1, least(coalesce(p_max_claims, 1), 10));
  v_lease integer := greatest(15, least(coalesce(p_lease_seconds, 60), 300));
begin
  return query
  with candidates as (
    select c.id
    from public.commands c
    where c.agent_id = p_agent_id
      and c.status = 'queued'::public.command_status
      and (c.lease_expires_at is null or c.lease_expires_at <= v_now)
    order by c.priority desc, c.created_at asc
    for update skip locked
    limit v_limit
  ),
  updated as (
    update public.commands c
    set status = 'dispatching'::public.command_status,
        claimed_by_agent_id = p_agent_id,
        claimed_at = v_now,
        lease_expires_at = v_now + make_interval(secs => v_lease),
        attempt_count = coalesce(c.attempt_count, 0) + 1,
        updated_at = v_now
    from candidates
    where c.id = candidates.id
    returning c.*
  )
  select * from updated;
end;
$$;
