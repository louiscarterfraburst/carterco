// Maps Meta lead-ads field_data to structured lead columns.
//
// field_data carries the form's question KEYS, and those keys are localized
// per form (Soho's Office-carter form: fulde_navn / virksomhedsnavn /
// telefonnummer / e-mail), so each standard column matches a synonym list
// covering Meta's English defaults plus the Danish keys in use. Unmatched
// fields land in `extra`, and the first of those becomes the qualifier.

export type LeadFieldData = { name: string; values: string[] };

export type ParsedLeadFields = {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  qualifier: string | null;
  extra: Record<string, string>;
};

const NAME_KEYS = ["full_name", "name", "fulde_navn", "navn"];
const EMAIL_KEYS = ["email", "e-mail", "e_mail", "mail"];
const PHONE_KEYS = ["phone_number", "phone", "telefonnummer", "telefon", "mobil"];
const COMPANY_KEYS = ["company_name", "company", "virksomhedsnavn", "virksomhed", "firma"];

export function parseFieldData(fields: LeadFieldData[] | undefined): ParsedLeadFields {
  const out: ParsedLeadFields = { name: null, email: null, phone: null, company: null, qualifier: null, extra: {} };
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    const slug = (f.name ?? "").toLowerCase();
    const val = (f.values?.[0] ?? "").trim();
    if (!val) continue;
    if (!out.name && NAME_KEYS.includes(slug)) { out.name = val; continue; }
    if (!out.name && (slug === "first_name" || slug === "last_name")) {
      out.extra[slug] = val;
      // Combine on second occurrence
      if (out.extra.first_name && out.extra.last_name) out.name = `${out.extra.first_name} ${out.extra.last_name}`.trim();
      continue;
    }
    if (!out.email && EMAIL_KEYS.includes(slug)) { out.email = val.toLowerCase(); continue; }
    if (!out.phone && PHONE_KEYS.includes(slug)) { out.phone = val; continue; }
    if (!out.company && COMPANY_KEYS.includes(slug)) { out.company = val; continue; }
    // Anything else (qualifier slug varies with the question label) lands in extra
    out.extra[slug] = val;
  }
  // Use first non-standard field as the qualifier if we have one
  if (!out.qualifier) {
    for (const [k, v] of Object.entries(out.extra)) {
      if (["first_name", "last_name"].includes(k)) continue;
      out.qualifier = v;
      break;
    }
  }
  return out;
}
