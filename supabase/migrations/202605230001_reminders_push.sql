-- Reminder and notification delivery architecture for QStash + Web Push.
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid references public.collaboration_groups(id) on delete cascade,
  task_id uuid references public.collaborative_tasks(id) on delete set null,
  title text not null,
  body text default '',
  reminder_at_utc timestamptz not null,
  source_timezone text not null default 'UTC',
  status text not null default 'scheduled' check (status in ('scheduled','schedule_failed','delivered','delivery_failed','cancelled')),
  qstash_message_id text,
  retries integer not null default 0,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reminder_delivery_events (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  event_type text not null check (event_type in ('scheduled','schedule_failed','delivery_attempt','delivered','delivery_failed','expired_subscription')),
  provider text not null default 'qstash_webpush',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  is_active boolean not null default true,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_reminders_user_status_time on public.reminders(user_id, status, reminder_at_utc);
create index if not exists idx_reminders_group_time on public.reminders(group_id, reminder_at_utc);
create index if not exists idx_reminder_events_reminder_created on public.reminder_delivery_events(reminder_id, created_at desc);
create index if not exists idx_push_subscriptions_user_active on public.push_subscriptions(user_id, is_active);

alter table public.reminders enable row level security;
alter table public.reminder_delivery_events enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "users read own reminders" on public.reminders for select using (user_id = auth.uid());
create policy "users create own reminders" on public.reminders for insert with check (user_id = auth.uid());
create policy "users update own reminders" on public.reminders for update using (user_id = auth.uid());

create policy "users read own reminder events" on public.reminder_delivery_events for select using (
  exists (select 1 from public.reminders r where r.id = reminder_id and r.user_id = auth.uid())
);

create policy "users read own subscriptions" on public.push_subscriptions for select using (user_id = auth.uid());
create policy "users create own subscriptions" on public.push_subscriptions for insert with check (user_id = auth.uid());
create policy "users update own subscriptions" on public.push_subscriptions for update using (user_id = auth.uid());

drop trigger if exists touch_reminders on public.reminders;
create trigger touch_reminders before update on public.reminders
for each row execute function public.touch_updated_at();

drop trigger if exists touch_push_subscriptions on public.push_subscriptions;
create trigger touch_push_subscriptions before update on public.push_subscriptions
for each row execute function public.touch_updated_at();
