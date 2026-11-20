-- GymOP Supabase schema
-- Run this entire file in Supabase Dashboard > SQL Editor > New query.
-- The application uses a server-only secret key for now. RLS is enabled and
-- no anon/authenticated policies are created. Do not expose the secret key.

create table if not exists public.gymop_weekly_uploads (
  gym_name text not null,
  week_start_date date not null,
  uploaded_at timestamptz not null,
  row_count integer not null check (row_count >= 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (gym_name, week_start_date)
);

create index if not exists gymop_weekly_uploads_week_idx
  on public.gymop_weekly_uploads (week_start_date desc);

create table if not exists public.gymop_gym_settings (
  gym_name text primary key,
  settings jsonb not null default
    '{"limits":{},"placements":{},"hasFloorPlan":false,"events":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.gymop_weekly_uploads enable row level security;
alter table public.gymop_gym_settings enable row level security;

-- Private bucket for sanitized PNG floor plans.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gymop-floor-plans', 'gymop-floor-plans', false, 10485760, array['image/png'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
