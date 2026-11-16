-- Community submissions: a public queue of skills / MCP servers people want
-- listed. No account is required, so rows are deliberately UNOWNED (no user_id):
-- anyone may submit, and the queue is world-readable. Nothing personal is
-- stored beyond the optional submitter credit the person chooses to type, and
-- every row is public by design.
--
-- `state` gates what the app will show as a listing:
--   pending  — submitted, not yet checked. Visible in the review queue only.
--   approved — verified as public + free licence; eligible for the index.
--   rejected — not public, not free, or not a skill/MCP server.
--
-- `url` is unique so one repository cannot flood the queue, and `check_note`
-- records why a row landed in its state so moderation is auditable.

create table if not exists skill_submissions (
  id serial primary key,
  url text not null unique,
  name text not null,
  kind text not null check (kind in ('skill', 'mcp')),
  description text not null default '',
  category text not null default 'development',
  license text not null default '',
  license_verified boolean not null default false,
  stars integer,
  updated timestamptz,
  topics text[] not null default '{}',
  submitter text not null default '',
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected')),
  check_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The index reads approved rows newest-first; the queue reads pending rows.
create index if not exists skill_submissions_state_created_idx
  on skill_submissions (state, created_at desc);

-- Lookup by normalised url happens on every submit (duplicate guard).
create index if not exists skill_submissions_url_idx
  on skill_submissions (url);
