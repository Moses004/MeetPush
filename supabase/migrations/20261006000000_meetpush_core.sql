create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  kind text not null default 'Meeting' check (kind in ('Meeting', 'Appointment', 'Event', 'Coffee')),
  starts_at timestamptz not null,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 1440),
  timezone text not null default 'UTC',
  location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.event_guests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  contact text not null check (char_length(contact) between 3 and 254),
  channel text not null check (channel in ('email', 'sms')),
  status text not null default 'ready' check (status in ('ready', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index event_guests_event_contact_lower_idx
  on public.event_guests (event_id, lower(contact));
create index event_guests_owner_event_idx on public.event_guests (owner_id, event_id);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  contact text not null check (char_length(contact) between 3 and 254),
  channel text not null check (channel in ('email', 'sms')),
  created_at timestamptz not null default now()
);

create unique index contacts_owner_contact_lower_idx
  on public.contacts (owner_id, lower(contact));

alter table public.events enable row level security;
alter table public.event_guests enable row level security;
alter table public.contacts enable row level security;

create policy "Users can read their own events"
  on public.events for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Users can create their own events"
  on public.events for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Users can update their own events"
  on public.events for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "Users can delete their own events"
  on public.events for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "Users can read guests on their own events"
  on public.event_guests for select to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.events e
      where e.id = event_guests.event_id and e.owner_id = (select auth.uid())
    )
  );
create policy "Users can add guests to their own events"
  on public.event_guests for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.events e
      where e.id = event_guests.event_id and e.owner_id = (select auth.uid())
    )
  );
create policy "Users can update guests on their own events"
  on public.event_guests for update to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.events e
      where e.id = event_guests.event_id and e.owner_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.events e
      where e.id = event_guests.event_id and e.owner_id = (select auth.uid())
    )
  );
create policy "Users can delete guests on their own events"
  on public.event_guests for delete to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.events e
      where e.id = event_guests.event_id and e.owner_id = (select auth.uid())
    )
  );

create policy "Users can read their own contacts"
  on public.contacts for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Users can create their own contacts"
  on public.contacts for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "Users can update their own contacts"
  on public.contacts for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "Users can delete their own contacts"
  on public.contacts for delete to authenticated
  using (owner_id = (select auth.uid()));

-- New Supabase projects no longer expose new public tables automatically.
-- Expose the minimum operations and let RLS enforce row ownership.
grant select, insert, update, delete on public.events to authenticated;
grant select, insert, update, delete on public.event_guests to authenticated;
grant select, insert, update, delete on public.contacts to authenticated;
