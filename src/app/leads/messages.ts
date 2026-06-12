// Pure message-template helpers for /leads, extracted from page.tsx so the
// sender-identity rules are unit-testable. The operator-fired SMS handoff and
// the email draft must introduce the WORKSPACE's brand on client panels —
// never the logged-in operator's personal identity.

export type Identity = {
  displayName: string;
  companyName: string;
  calendlyUrl: string;
  signoff: string;
};

// Per-workspace branding. When bookingUrl is set (e.g. Soho's Nexudus link),
// drafts use the client's template (their brand + the logged-in receptionist)
// instead of the operator's identity.
export type Branding = {
  bookingUrl: string | null;
  signoff: string | null;
  companyName: string | null;
  signerName: string | null;
};

export function firstName(name: string | null) {
  if (!name) return "der";
  return name.trim().split(/\s+/)[0] ?? name;
}

export function buildSmsBody(
  name: string | null,
  identity: Identity,
  slotsLine?: string,
  branding?: Branding,
) {
  const slot = slotsLine ? ` Hvordan ser din kalender ud ${slotsLine}?` : "";
  // Client panels (bookingUrl set — same gate as the email template): the SMS
  // introduces the workspace's brand and the receptionist who taps the button
  // ("det er Lee fra Soho", not "Louis fra Carter & Co" because Louis happened
  // to be the one logged in).
  if (branding?.bookingUrl) {
    const brand = branding.signoff ?? branding.companyName ?? identity.companyName;
    const me = branding.signerName ?? identity.displayName;
    return `Hej ${firstName(name)}, det er ${me} fra ${brand} - jeg prøvede lige at ringe.${slot} /${me}`;
  }
  return `Hej ${firstName(name)}, det er ${identity.displayName} fra ${identity.companyName} - jeg prøvede lige at ringe.${slot} /${identity.signoff}`;
}
