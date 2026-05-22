-- Carry website from intake → outreach_leads so sendspark renders don't fail
-- the missing_website gate. Previously lead_inbox lost the website at import,
-- promoteFromInbox couldn't restore it, and every accepted lead from a
-- LinkedIn-only batch (e.g. "fb leads") hit the render-time fallback guard.
alter table public.lead_inbox add column if not exists website text;
