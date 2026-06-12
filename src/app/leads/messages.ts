// Pure message-template helpers for /leads, extracted from page.tsx so the
// sender-identity rules are unit-testable. The operator-fired SMS handoff and
// the email draft must speak the WORKSPACE's voice — its own message when one
// is configured, never the logged-in operator's personal identity on a client
// panel.

export type Identity = {
  displayName: string;
  companyName: string;
  calendlyUrl: string;
  signoff: string;
};

// Per-workspace branding from the workspaces row. smsTemplate is the
// workspace's own no-answer message (workspaces.sms_template) and takes
// precedence over every built-in sentence; bookingUrl gates the generic
// client-panel fallback (same gate as the email template).
export type Branding = {
  bookingUrl: string | null;
  signoff: string | null;
  companyName: string | null;
  signerName: string | null;
  smsTemplate: string | null;
  // How "Skriv mail" composes (mailto | gmail | outlook) — unused by the SMS
  // helpers, carried here because Branding is the workspace-voice bundle.
  mailProvider?: string | null;
};

export function firstName(name: string | null) {
  if (!name) return "der";
  return name.trim().split(/\s+/)[0] ?? name;
}

// Substitutes the workspace template's tokens. {slots} renders the full
// calendar question when slot suggestions exist, otherwise disappears —
// collapse the whitespace it leaves behind so the SMS never shows a double
// space or a dangling gap before punctuation.
export function renderSmsTemplate(
  template: string,
  vars: {
    fornavn: string;
    medarbejder: string;
    brand: string;
    booking: string | null;
    slots: string | null;
  },
) {
  const slotsSentence = vars.slots ? `Hvordan ser din kalender ud ${vars.slots}?` : "";
  return template
    .replaceAll("{fornavn}", vars.fornavn)
    .replaceAll("{medarbejder}", vars.medarbejder)
    .replaceAll("{brand}", vars.brand)
    .replaceAll("{booking}", vars.booking ?? "")
    .replaceAll("{slots}", slotsSentence)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function buildSmsBody(
  name: string | null,
  identity: Identity,
  slotsLine?: string,
  branding?: Branding,
) {
  const me = branding?.signerName ?? identity.displayName;
  const brand = branding?.signoff ?? branding?.companyName ?? identity.companyName;

  // A workspace with its own template owns the message outright.
  if (branding?.smsTemplate) {
    return renderSmsTemplate(branding.smsTemplate, {
      fornavn: firstName(name),
      medarbejder: me,
      brand,
      booking: branding.bookingUrl,
      slots: slotsLine ?? null,
    });
  }

  const slot = slotsLine ? ` Hvordan ser din kalender ud ${slotsLine}?` : "";
  // Client panels without a template (bookingUrl set): generic sentence, but
  // introducing the workspace's brand and the receptionist who taps the
  // button ("det er Lee fra Soho", not "Louis fra Carter & Co" because Louis
  // happened to be the one logged in).
  if (branding?.bookingUrl) {
    return `Hej ${firstName(name)}, det er ${me} fra ${brand} - jeg prøvede lige at ringe.${slot} /${me}`;
  }
  return `Hej ${firstName(name)}, det er ${identity.displayName} fra ${identity.companyName} - jeg prøvede lige at ringe.${slot} /${identity.signoff}`;
}
