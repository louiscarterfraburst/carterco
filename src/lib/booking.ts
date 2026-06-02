// Single source of truth for the public booking link (cal.com).
// Migrated off Calendly 2026-06-02. Bookings flow back into /leads + /meetings
// via the cal-webhook edge function.
export const BOOKING_URL = "https://cal.com/louis-carter-3twilu/20min";

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
