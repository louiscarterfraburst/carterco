-- Tighten workspace_senders so a sender can only ever belong to one workspace,
-- and only one sender per workspace is "active" at a time. Codex flagged
-- both as gaps in the original lock migration.
--
--   1. UNIQUE(sendpilot_sender_id) globally — one LinkedIn account = one
--      identity. If you genuinely need to reassign a sender, mark the old
--      row inactive (or delete it) before adding the new one. Prevents
--      "(carterco, sender_X) AND (tresyv, sender_X)" both being treated as
--      canonical for sender_X.
--
--   2. UNIQUE INDEX on (workspace_id) WHERE is_active — at most one active
--      sender per workspace. canonical_sender_for() becomes deterministic;
--      no more "order by added_at desc limit 1" ambiguity if two are active.

alter table public.workspace_senders
  add constraint workspace_senders_sender_unique unique (sendpilot_sender_id);

create unique index if not exists workspace_senders_one_active_per_ws
  on public.workspace_senders (workspace_id)
  where is_active = true;
