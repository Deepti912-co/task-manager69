create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  scheduled_time timestamptz not null,
  timezone text not null default 'UTC',
  sent boolean not null default false,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sending','sent','retry_scheduled','fallback_required','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  timezone text not null default 'UTC',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.reminder_delivery_events (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'web_push' check (channel in ('web_push','email','telegram')),
  status text not null check (status in ('sent','failed','expired','fallback_queued')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_reminders_due_pending on public.reminders(sent, scheduled_time, next_attempt_at) where sent = false;
create index if not exists idx_reminders_user_time on public.reminders(user_id, scheduled_time desc);
create index if not exists idx_push_subscriptions_user_enabled on public.push_subscriptions(user_id, enabled);
create index if not exists idx_reminder_delivery_events_user_created on public.reminder_delivery_events(user_id, created_at desc);

alter table public.reminders enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminder_delivery_events enable row level security;

create policy "users can read own reminders" on public.reminders for select using (user_id = auth.uid());
create policy "users can create own reminders" on public.reminders for insert with check (user_id = auth.uid());
create policy "users can update own reminders" on public.reminders for update using (user_id = auth.uid());

create policy "users can read own push subscriptions" on public.push_subscriptions for select using (user_id = auth.uid());
create policy "users can create own push subscriptions" on public.push_subscriptions for insert with check (user_id = auth.uid());
create policy "users can update own push subscriptions" on public.push_subscriptions for update using (user_id = auth.uid());
create policy "users can delete own push subscriptions" on public.push_subscriptions for delete using (user_id = auth.uid());

create policy "users can read own reminder delivery events" on public.reminder_delivery_events for select using (user_id = auth.uid());

create or replace function public.claim_due_reminders(batch_size integer default 100)
returns setof public.reminders
language sql
security definer
set search_path = public
as $$
  update public.reminders r
  set delivery_status = 'sending', attempts = attempts + 1
  where r.id in (
    select id
    from public.reminders
    where sent = false
      and scheduled_time <= now()
      and next_attempt_at <= now()
    order by scheduled_time asc
    limit batch_size
    for update skip locked
  )
  returning r.*;
$$;
