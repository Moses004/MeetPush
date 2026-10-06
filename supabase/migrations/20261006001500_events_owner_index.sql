create index if not exists events_owner_starts_at_idx
  on public.events (owner_id, starts_at);
