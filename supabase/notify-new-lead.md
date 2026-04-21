# New lead push notifications

The `/leads` page stores browser push subscriptions in `public.push_subscriptions`.
The `notify-new-lead` Supabase Edge Function sends a Web Push notification to
those saved endpoints when it receives a new lead payload.

The public VAPID key also needs to be available to the static app:

```sh
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
```

## Required function secrets

Set these for the Supabase project:

```sh
supabase secrets set VAPID_SUBJECT=mailto:louis@carterco.dk
supabase secrets set VAPID_PUBLIC_KEY=...
supabase secrets set VAPID_PRIVATE_KEY=...
supabase secrets set LEAD_WEBHOOK_SECRET=...
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available automatically in
Supabase Edge Functions.

## Deploy

```sh
supabase functions deploy notify-new-lead
```

## Trigger

Create a Supabase Database Webhook:

- Table: `public.leads`
- Events: `Insert`
- Type: `HTTP Request`
- Method: `POST`
- URL: `https://<project-ref>.functions.supabase.co/notify-new-lead`
- Headers:
  - `Authorization: Bearer <anon-or-service-role-key>`
  - `x-webhook-secret: <LEAD_WEBHOOK_SECRET>`

Supabase sends a payload with the new row in `record`; the function also accepts
the lead row directly for manual testing.

## Manual test

```sh
SUPABASE_FUNCTION_URL=https://<project-ref>.functions.supabase.co/notify-new-lead \
LEAD_WEBHOOK_SECRET=... \
sh scripts/test-lead-push.sh
```

## Auth email code template

`/leads` verifies the 6-digit email OTP directly. Supabase sends a magic link by
default unless the Magic Link template uses `{{ .Token }}`.

Run:

```sh
SUPABASE_ACCESS_TOKEN=... sh scripts/configure-supabase-otp-email.sh
```

This sets the Supabase Auth Site URL to `https://carterco.dk`, allow-lists
`https://carterco.dk/leads`, and replaces the Magic Link email body with the
6-digit token.
