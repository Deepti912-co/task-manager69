-- Collaborative Productivity Messenger extension for Voca.
-- Safe additive migration: it creates collaboration tables without mutating personal tasks.
create extension if not exists "pgcrypto";

create table if not exists public.collaboration_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  description text default '',
  avatar text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_memberships (
  group_id uuid not null references public.collaboration_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (group_id, user_id)
);

create table if not exists public.group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.collaboration_groups(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  message_type text not null default 'text' check (message_type in ('text','task','system')),
  body text not null,
  reply_to uuid references public.group_messages(id) on delete set null,
  task_id uuid,
  read_by uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.message_reactions (
  message_id uuid not null references public.group_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.collaborative_tasks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.collaboration_groups(id) on delete cascade,
  title text not null,
  description text default '',
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete cascade,
  due_at timestamptz,
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  completed boolean not null default false,
  progress integer not null default 0 check (progress between 0 and 100),
  comments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_activity (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.collaboration_groups(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  activity_type text not null check (activity_type in ('member','message','task','deadline','system')),
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.collaboration_groups(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  invited_user_id uuid references auth.users(id) on delete cascade,
  invited_email text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  check (invited_user_id is not null or invited_email is not null)
);

create table if not exists public.collaboration_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid references public.collaboration_groups(id) on delete cascade,
  notification_type text not null check (notification_type in ('assignment','mention','unread','invite')),
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_group_memberships_user on public.group_memberships(user_id);
create index if not exists idx_group_messages_group_created on public.group_messages(group_id, created_at desc);
create index if not exists idx_collaborative_tasks_group_status on public.collaborative_tasks(group_id, completed, due_at);
create index if not exists idx_collaborative_tasks_assignee on public.collaborative_tasks(assigned_to);
create index if not exists idx_group_activity_group_created on public.group_activity(group_id, created_at desc);
create index if not exists idx_group_invites_group_status on public.group_invites(group_id, status, expires_at);
create index if not exists idx_group_invites_invited_user on public.group_invites(invited_user_id, status);
create index if not exists idx_collaboration_notifications_user_read on public.collaboration_notifications(user_id, read_at, created_at desc);

alter table public.collaboration_groups enable row level security;
alter table public.group_memberships enable row level security;
alter table public.group_messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.collaborative_tasks enable row level security;
alter table public.group_activity enable row level security;
alter table public.group_invites enable row level security;
alter table public.collaboration_notifications enable row level security;

create or replace function public.is_group_member(target_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_memberships gm
    where gm.group_id = target_group and gm.user_id = auth.uid()
  );
$$;


create or replace function public.is_group_admin(target_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_memberships gm
    where gm.group_id = target_group and gm.user_id = auth.uid() and gm.role in ('owner','admin')
  );
$$;

create policy "group members can read groups" on public.collaboration_groups for select using (public.is_group_member(id));
create policy "authenticated users can create groups" on public.collaboration_groups for insert with check (created_by = auth.uid());
create policy "owners and admins can update groups" on public.collaboration_groups for update using (public.is_group_admin(id));

create policy "members can read memberships" on public.group_memberships for select using (public.is_group_member(group_id));
create policy "users can join invited groups" on public.group_memberships for insert with check (
  (user_id = auth.uid() and exists (select 1 from public.group_invites gi where gi.group_id = group_memberships.group_id and gi.invited_user_id = auth.uid() and gi.status = 'pending' and gi.expires_at > now()))
  or public.is_group_admin(group_id)
);
create policy "users can leave groups" on public.group_memberships for delete using (user_id = auth.uid() or public.is_group_admin(group_id));

create policy "members can read messages" on public.group_messages for select using (public.is_group_member(group_id));
create policy "members can send messages" on public.group_messages for insert with check (public.is_group_member(group_id) and (author_id = auth.uid() or message_type = 'system'));
create policy "authors can update messages" on public.group_messages for update using (author_id = auth.uid() and public.is_group_member(group_id));

create policy "members can read reactions" on public.message_reactions for select using (exists (select 1 from public.group_messages m where m.id = message_id and public.is_group_member(m.group_id)));
create policy "members can react" on public.message_reactions for insert with check (user_id = auth.uid() and exists (select 1 from public.group_messages m where m.id = message_id and public.is_group_member(m.group_id)));
create policy "users can remove own reactions" on public.message_reactions for delete using (user_id = auth.uid());

create policy "members can read collaborative tasks" on public.collaborative_tasks for select using (public.is_group_member(group_id));
create policy "members can create collaborative tasks" on public.collaborative_tasks for insert with check (created_by = auth.uid() and public.is_group_member(group_id));
create policy "members can update collaborative tasks" on public.collaborative_tasks for update using (public.is_group_member(group_id));

create policy "members can read activity" on public.group_activity for select using (public.is_group_member(group_id));
create policy "members can create activity" on public.group_activity for insert with check (public.is_group_member(group_id));

create policy "members can create invites" on public.group_invites for insert with check (public.is_group_admin(group_id));
create policy "members can read group invites" on public.group_invites for select using (public.is_group_member(group_id) or invited_user_id = auth.uid());
create policy "invitees can update own invites" on public.group_invites for update using (invited_user_id = auth.uid());

create policy "users can read own notifications" on public.collaboration_notifications for select using (user_id = auth.uid());
create policy "users can update own notifications" on public.collaboration_notifications for update using (user_id = auth.uid());


create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_collaboration_groups on public.collaboration_groups;
create trigger touch_collaboration_groups before update on public.collaboration_groups
for each row execute function public.touch_updated_at();

drop trigger if exists touch_group_messages on public.group_messages;
create trigger touch_group_messages before update on public.group_messages
for each row execute function public.touch_updated_at();

drop trigger if exists touch_collaborative_tasks on public.collaborative_tasks;
create trigger touch_collaborative_tasks before update on public.collaborative_tasks
for each row execute function public.touch_updated_at();

create or replace function public.add_group_creator_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.group_memberships (group_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists add_group_creator_membership on public.collaboration_groups;
create trigger add_group_creator_membership after insert on public.collaboration_groups
for each row execute function public.add_group_creator_membership();
