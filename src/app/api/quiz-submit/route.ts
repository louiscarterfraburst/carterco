// Lead Flex scoping endpoint (CEO plan 2026-06-10, repurposed from the old
// lead-quiz submission route — kept at this path so the modal's existing
// fetch target survives; the old quiz body shape is gone with the quiz).
//
// Two kinds:
//   "booking"      — persist-then-book: the two scoping answers are saved
//                    BEFORE the cal.com redirect and the returned id travels
//                    as a `scoping:<id>` token in the booking notes.
//                    Anonymous by design; identity arrives via cal-webhook.
//   "soft_capture" — the alternative exit ("skriv til mig i stedet"):
//                    email + explicit consent required; mirrors into `leads`
//                    (deduped by email) so the notify-new-lead trigger fires.
//
// Spam posture per owner decision: honeypot only, no rate limiting.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  CUSTOMER_SOURCE_MAX,
  CUSTOMER_SOURCE_MIN,
  ICP_MAX,
  ICP_MIN,
  formatScopingNote,
} from "@/lib/scoping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  kind?: "booking" | "soft_capture";
  icp?: string;
  customerSource?: string;
  email?: string;
  name?: string;
  consent?: boolean;
  locale?: string;
  // Honeypot — visually hidden field; humans leave it empty.
  website?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// CarterCo workspace — the leads table requires workspace_id and the
// notify-new-lead trigger keys push notifications to it.
const CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Honeypot tripped → pretend success, write nothing.
  if ((body.website ?? "").trim()) {
    return NextResponse.json({ ok: true });
  }

  const kind = body.kind;
  if (kind !== "booking" && kind !== "soft_capture") {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }

  const icp = (body.icp ?? "").trim().slice(0, ICP_MAX);
  if (icp.length < ICP_MIN) {
    return NextResponse.json(
      { error: `icp too short (min ${ICP_MIN} chars)` },
      { status: 400 },
    );
  }

  const customerSource = (body.customerSource ?? "")
    .trim()
    .slice(0, CUSTOMER_SOURCE_MAX);
  if (customerSource.length < CUSTOMER_SOURCE_MIN) {
    return NextResponse.json(
      { error: `customerSource too short (min ${CUSTOMER_SOURCE_MIN} chars)` },
      { status: 400 },
    );
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim().slice(0, 120) || null;

  if (kind === "soft_capture") {
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "valid email required" }, { status: 400 });
    }
    if (body.consent !== true) {
      return NextResponse.json({ error: "consent required" }, { status: 400 });
    }
  }

  const supabase = createAdminClient();
  const userAgent = req.headers.get("user-agent")?.slice(0, 300) ?? null;
  const referer = req.headers.get("referer")?.slice(0, 300) ?? null;

  const { data: row, error: insErr } = await supabase
    .from("scoping_submissions")
    .insert({
      kind,
      icp,
      customer_source: customerSource,
      email: kind === "soft_capture" ? email : null,
      name,
      consent: kind === "soft_capture",
      locale: body.locale === "en" ? "en" : "da",
      user_agent: userAgent,
      referrer: referer,
    })
    .select("id")
    .single();

  if (insErr || !row) {
    return NextResponse.json(
      { error: "db insert failed", details: insErr?.message },
      { status: 500 },
    );
  }

  if (kind === "soft_capture") {
    // Mirror into `leads` (notify-new-lead trigger fires push + the lead
    // shows in /leads). Dedupe by email: an existing non-draft lead gets the
    // scoping context appended instead of a duplicate row. Failure non-fatal —
    // the scoping row above is the durable record.
    try {
      const note = formatScopingNote(icp, customerSource);
      // Workspace-scoped dedupe (leads is multi-tenant) + ilike-metachar
      // escape so a crafted email can't pattern-match another lead.
      const emailPattern = email.replace(/[%_]/g, "\\$&");
      const { data: existing } = await supabase
        .from("leads")
        .select("id, notes")
        .eq("is_draft", false)
        .eq("workspace_id", CARTERCO_WORKSPACE_ID)
        .ilike("email", emailPattern)
        .limit(1);
      if (existing && existing.length > 0) {
        const merged = [existing[0].notes, note].filter(Boolean).join("\n---\n");
        const { error: updErr } = await supabase
          .from("leads")
          .update({ notes: merged })
          .eq("id", existing[0].id);
        if (updErr) console.error("quiz-submit: leads-dedupe-update failed", updErr);
        await supabase
          .from("scoping_submissions")
          .update({ lead_id: existing[0].id })
          .eq("id", row.id);
      } else {
        const { data: lead, error: leadErr } = await supabase
          .from("leads")
          .insert({
            name,
            email,
            source: "flex_soft_capture",
            notes: note,
            page_url: referer,
            user_agent: userAgent,
            workspace_id: CARTERCO_WORKSPACE_ID,
            is_draft: false,
          })
          .select("id")
          .single();
        if (leadErr) {
          console.error("quiz-submit: leads-mirror failed", leadErr);
        } else if (lead) {
          await supabase
            .from("scoping_submissions")
            .update({ lead_id: lead.id })
            .eq("id", row.id);
        }
      }
    } catch (e) {
      console.error("quiz-submit: leads-mirror failed", e);
    }
  }

  return NextResponse.json({ ok: true, id: row.id });
}
