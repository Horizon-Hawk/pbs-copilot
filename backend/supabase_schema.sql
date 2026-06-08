-- Run this in the Supabase SQL editor to set up the tokens table.

create table if not exists tokens (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  used       boolean not null default false,
  note       text,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  expires_at timestamptz
);

-- Index for fast token lookups
create index if not exists tokens_code_idx on tokens (code);

-- Row Level Security: service role only (no public access)
alter table tokens enable row level security;

create policy "service role only"
  on tokens
  using (false);
