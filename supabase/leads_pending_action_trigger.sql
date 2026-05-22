-- Keep scheduled actions for live follow-up outcomes. Only terminal outcomes
-- should clear next_action_at automatically.
create or replace function public.clear_pending_action_on_outcome()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.outcome is not null
     and new.outcome not in ('callback', 'follow_up', 'interested')
     and (old.outcome is null or old.outcome is distinct from new.outcome)
  then
    new.next_action_at := null;
    new.next_action_type := null;
  end if;
  return new;
end;
$$;
