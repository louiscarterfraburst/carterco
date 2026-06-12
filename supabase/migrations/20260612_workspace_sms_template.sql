-- Per-workspace SMS message template for the /leads "Intet svar · SMS"
-- handoff. Until now every workspace shared one hardcoded sentence with the
-- names substituted; the message itself is workspace voice and belongs on the
-- workspace row (same pattern as signoff / booking_url / outcome_preset).
--
-- Tokens substituted at render time (src/app/leads/messages.ts):
--   {fornavn}      lead's first name ("der" when unknown)
--   {medarbejder}  the logged-in receptionist's roster name
--   {brand}        workspaces.signoff, falling back to workspaces.name
--   {booking}      workspaces.booking_url
--   {slots}        "Hvordan ser din kalender ud <slots>?" when slot
--                  suggestions are configured, otherwise empty
--
-- NULL = use the built-in default (operator identity / branding fallback).

alter table public.workspaces
  add column if not exists sms_template text;

comment on column public.workspaces.sms_template is
  'No-answer SMS handoff template for /leads, with {fornavn}/{medarbejder}/{brand}/{booking}/{slots} tokens. NULL = built-in default message.';

update public.workspaces
   set sms_template = 'Hej {fornavn}, det er {medarbejder} fra Soho - jeg prøvede lige at ringe ang. jeres forespørgsel om mødelokale i Klosterstræde. Du kan booke direkte her: {booking} - eller ring/skriv når det passer dig. /{medarbejder}'
 where id = 'c61aaffb-518b-4995-ac31-5a2e7300b1f2';
