// Single source of truth for the public booking links (cal.com).
// Migrated off Calendly 2026-06-02. Bookings flow back into /leads + /meetings
// via the cal-webhook edge function.
// NB: the cal.com slug is "20-min" (hyphen). The old "20min" value 404'ed in
// production — caught by the pre-merge review 2026-06-11.
export const BOOKING_URL = "https://cal.com/louis-carter-3twilu/20-min";

// Lead Flex booking (CEO plan 2026-06-10): 30-min event with opt-in booking
// confirmation, so the operator reads the scoping answer before the meeting
// confirms. The event type must exist in cal.com before this URL goes live —
// creation is on the ship checklist.
export const FLEX_BOOKING_URL =
  "https://cal.com/louis-carter-3twilu/find-dine-kobere";

// Token the cal-webhook join looks for in the booking notes. Only the short
// id travels through cal.com — the scoping answers are persisted server-side
// BEFORE the redirect (persist-then-book), so the user-editable notes field
// is never load-bearing for the answers themselves.
export function scopingToken(scopingId: string): string {
  return `scoping:${scopingId}`;
}

// Build the flex booking URL. cal.com prefills the `notes` field from the
// query param; only the scoping token goes there.
export function flexBookingUrl(opts: {
  scopingId: string;
  utm_source?: string;
  utm_medium?: string;
}): string {
  const p = new URLSearchParams();
  p.set("notes", scopingToken(opts.scopingId));
  if (opts.utm_source) p.set("utm_source", opts.utm_source);
  if (opts.utm_medium) p.set("utm_medium", opts.utm_medium);
  return `${FLEX_BOOKING_URL}?${p.toString()}`;
}

// Build a cal.com booking URL with the visitor's info prefilled.
// cal.com prefills `name` and `email` directly; the 20-min event has no custom
// fields, so company + phone go into `notes`. Unknown params (utm_*) are
// harmless — cal.com ignores them.
export function bookingUrl(opts: {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  utm_source?: string;
  utm_medium?: string;
} = {}): string {
  const p = new URLSearchParams();
  if (opts.name) p.set("name", opts.name);
  if (opts.email) p.set("email", opts.email);
  const notes: string[] = [];
  if (opts.company) notes.push(`Firma: ${opts.company}`);
  if (opts.phone) notes.push(`Tlf: ${opts.phone}`);
  if (notes.length) p.set("notes", notes.join(" · "));
  if (opts.utm_source) p.set("utm_source", opts.utm_source);
  if (opts.utm_medium) p.set("utm_medium", opts.utm_medium);
  const qs = p.toString();
  return qs ? `${BOOKING_URL}?${qs}` : BOOKING_URL;
}
