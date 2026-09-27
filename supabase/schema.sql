-- À exécuter une seule fois dans Supabase > SQL Editor.
-- Le bot utilise uniquement la clé service_role côté serveur.

create table if not exists public.bot_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.bot_state enable row level security;

grant all on table public.bot_state to service_role;

create table if not exists public.access_grants (
  discord_user_id text primary key,
  lifetime boolean not null default false,
  expires_at timestamptz,
  added_by text,
  added_at timestamptz,
  duration_text text
);

alter table public.access_grants enable row level security;

revoke all on table public.access_grants from anon, authenticated;
grant all on table public.access_grants to service_role;

create table if not exists public.review_messages (
  message_id text primary key,
  channel_id text not null,
  type text not null check (type in ('rep', 'photo')),
  created_at timestamptz not null
);

create index if not exists review_messages_channel_created_idx
  on public.review_messages (channel_id, created_at);

alter table public.review_messages enable row level security;

revoke all on table public.review_messages from anon, authenticated;
grant all on table public.review_messages to service_role;