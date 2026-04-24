import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DripifyPayload = Record<string, unknown>;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Dripify can't send custom headers, so auth is a ?secret= query param.
  const expectedSecret = Deno.env.get("DRIPIFY_WEBHOOK_SECRET");
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get("secret");
  if (expectedSecret && providedSecret !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: DripifyPayload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing Supabase env" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const lead = extractLead(payload);
  if (!lead.email && !lead.linkedin_url) {
    // Nothing we can match on — log and 202 so Dripify doesn't retry forever.
    console.warn("Dripify payload missing email & linkedin_url", payload);
    return json({ ok: false, reason: "No email or LinkedIn URL" }, 202);
  }

  // Dedupe: match by email first, then linkedin_url
  const existing = await findExistingLead(
    supabase,
    lead.email,
    lead.linkedin_url,
  );

  const note = buildEventNote(payload);
  const basePayload = {
    name: lead.name ?? null,
    company: lead.company ?? null,
    email: lead.email ?? null,
    phone: lead.phone ?? null,
    linkedin_url: lead.linkedin_url ?? null,
    source: "dripify",
    is_draft: false,
    page_url: null,
    user_agent: null,
  };

  if (existing) {
    // Merge: only overwrite null fields, don't clobber data we already have
    const mergePayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(basePayload)) {
      if (value && !existing[key]) mergePayload[key] = value;
    }
    // Always append note to existing notes
    const nextNotes = existing.notes ? `${existing.notes}\n${note}` : note;
    mergePayload.notes = nextNotes;

    const { error: updateErr } = await supabase
      .from("leads")
      .update(mergePayload)
      .eq("id", existing.id);
    if (updateErr) return json({ error: updateErr.message }, 500);
    return json({ ok: true, action: "updated", id: existing.id });
  }

  // New lead
  const { data: inserted, error: insertErr } = await supabase
    .from("leads")
    .insert({ ...basePayload, notes: note })
    .select("id")
    .single();
  if (insertErr) return json({ error: insertErr.message }, 500);
  return json({ ok: true, action: "created", id: inserted?.id });
});

function extractLead(payload: DripifyPayload) {
  // Dripify sometimes nests lead data, sometimes flattens it. Try both.
  const leadCandidate =
    (payload.lead as Record<string, unknown> | undefined) ??
    (payload.prospect as Record<string, unknown> | undefined) ??
    payload;

  const get = (obj: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return null;
  };

  const firstName = get(leadCandidate as Record<string, unknown>, [
    "first_name",
    "firstName",
    "firstname",
  ]);
  const lastName = get(leadCandidate as Record<string, unknown>, [
    "last_name",
    "lastName",
    "lastname",
  ]);
  const fullName = get(leadCandidate as Record<string, unknown>, [
    "full_name",
    "fullName",
    "name",
  ]);
  const name = fullName
    ? fullName
    : firstName || lastName
      ? [firstName, lastName].filter(Boolean).join(" ")
      : null;

  const company = get(leadCandidate as Record<string, unknown>, [
    "company",
    "company_name",
    "organization",
  ]);
  const email = get(leadCandidate as Record<string, unknown>, [
    "email",
    "work_email",
    "primary_email",
  ])?.toLowerCase() ?? null;
  const phone = get(leadCandidate as Record<string, unknown>, [
    "phone",
    "phone_number",
    "mobile",
  ]);
  const linkedin_url = get(leadCandidate as Record<string, unknown>, [
    "linkedin_url",
    "linkedinUrl",
    "profile_url",
    "profileUrl",
    "url",
  ]);

  return { name, company, email, phone, linkedin_url };
}

async function findExistingLead(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
  linkedinUrl: string | null,
) {
  if (email) {
    const { data } = await supabase
      .from("leads")
      .select("id, name, company, email, phone, linkedin_url, notes")
      .eq("is_draft", false)
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  if (linkedinUrl) {
    const { data } = await supabase
      .from("leads")
      .select("id, name, company, email, phone, linkedin_url, notes")
      .eq("is_draft", false)
      .eq("linkedin_url", linkedinUrl)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

function buildEventNote(payload: DripifyPayload) {
  const eventName =
    (payload.event as string | undefined) ??
    (payload.event_type as string | undefined) ??
    (payload.trigger as string | undefined) ??
    "event";
  const campaign =
    ((payload.campaign as Record<string, unknown> | undefined)?.name as
      | string
      | undefined) ??
    (payload.campaign_name as string | undefined) ??
    null;
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const prefix = campaign
    ? `Dripify · ${campaign} · ${eventName}`
    : `Dripify · ${eventName}`;
  return `[${timestamp}] ${prefix}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
