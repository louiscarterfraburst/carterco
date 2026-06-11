-- Lead Flex scoping step 2 pivot (2026-06-11): the form now asks where the
-- prospect's current customers come from, as a single required free-text
-- field (no chips), instead of "what have you tried for lead generation".
-- Additive on purpose: the live site keeps writing `tried` until the new
-- code deploys, and `tried` stays as the historical record of old-form rows.
alter table public.scoping_submissions
  add column customer_source text;
