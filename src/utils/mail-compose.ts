// Provider-aware mail compose links for the /leads "Skriv mail" handoff.
//
// mailto: relies on the machine having a default mail client configured —
// fine for desktop Outlook, dead on webmail-only setups. Workspaces declare
// where their team actually writes mail (workspaces.mail_provider), and the
// button deeplinks straight into that client's compose view:
//   gmail   → Gmail web compose (requires being logged in in the browser)
//   outlook → Outlook on the web compose (Soho is Microsoft 365)
//   mailto  → OS default client (the previous behaviour, and the fallback)

export type MailProvider = "mailto" | "gmail" | "outlook";

export function normalizeMailProvider(value: string | null | undefined): MailProvider {
  return value === "gmail" || value === "outlook" ? value : "mailto";
}

export function mailComposeUrl(
  provider: string | null | undefined,
  to: string,
  subject: string,
  body: string,
): string {
  const s = encodeURIComponent(subject);
  const b = encodeURIComponent(body);
  const t = encodeURIComponent(to);
  switch (normalizeMailProvider(provider)) {
    case "gmail":
      return `https://mail.google.com/mail/?view=cm&fs=1&to=${t}&su=${s}&body=${b}`;
    case "outlook":
      return `https://outlook.office.com/mail/deeplink/compose?to=${t}&subject=${s}&body=${b}`;
    default:
      return `mailto:${to}?subject=${s}&body=${b}`;
  }
}

// Web composers must open in a new tab; mailto must NOT (it would blank the tab).
export function opensInNewTab(provider: string | null | undefined): boolean {
  return normalizeMailProvider(provider) !== "mailto";
}
