-- Hand Cricket: friend groups + leaderboard.
-- Paste this whole file into the Supabase SQL editor and press Run. Safe to run again.
--
-- Only the game server talks to these tables, using the service-role key (which skips RLS).
-- RLS is on with NO policies, so the public "anon" key can't read or write anything.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- Players: id is the random playerId each browser keeps in localStorage.
create table if not exists public.players (
  id          uuid primary key,
  name        text not null check (char_length(name) between 1 and 20),
  created_at  timestamptz not null default now()
);

create table if not exists public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 30),
  invite_code  text not null unique check (invite_code ~ '^[A-HJKMNP-Z2-9]{6}$'),
  created_by   uuid references public.players (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id   uuid not null references public.groups (id) on delete cascade,
  player_id  uuid not null references public.players (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (group_id, player_id)
);

-- One row per finished friend match. winner is null for a tie.
create table if not exists public.matches (
  id         uuid primary key,          -- chosen by the server once per match, so retries can't double-count
  room_code  text not null,
  player_a   uuid not null references public.players (id),
  player_b   uuid not null references public.players (id),
  score_a    int  not null check (score_a >= 0),
  score_b    int  not null check (score_b >= 0),
  winner     uuid references public.players (id),
  played_at  timestamptz not null default now(),
  check (player_a <> player_b),
  check (winner is null or winner = player_a or winner = player_b)
);

-- Leaderboard queries: "groups of this player", "members of this group",
-- and "matches between these players, newest first / since Monday".
create index if not exists group_members_player_idx on public.group_members (player_id);
create index if not exists matches_player_a_idx     on public.matches (player_a, played_at desc);
create index if not exists matches_player_b_idx     on public.matches (player_b, played_at desc);
create index if not exists matches_played_at_idx    on public.matches (played_at desc);

alter table public.players       enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.matches       enable row level security;
-- No policies on purpose: nothing is readable or writable with the public anon key.
