// Lead-quiz submission endpoint. Persists the submission + mirrors into
// the leads table. As of 2026-05-22 (Phase 1 SMS rebuild) does NOT fire
// any outbound SMS — operator-triggered only via /leads.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  email?: string;
  phone?: string;
  url?: string;
  // 2026-05-21: chosen path on the result step — "loom" = async audit via
  // CRM share; "meeting" = 30-min call. Drives SMS body wording.
  path?: "loom" | "meeting";
  monthlyLeads?: number;
  dealValue?: number;
  closeRate?: number;
  responseTime?: string;
  channels?: string[];
  outboundQuality?: string;
  followupQuality?: string;
  totalLoss?: number;
  // 2026-05-18: renamed from speedLoss/closeRateLoss/channelLoss to the
  // three-machine framing. Old field names removed; DB columns keep their
  // existing names for now (speed_loss / close_rate_loss / channel_loss
  // = hastighed / opfølgning / outbound respectively).
  hastighedLoss?: number;
  outboundLoss?: number;
  opfølgningLoss?: number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// CarterCo workspace — the leads table requires workspace_id and the
// notify-new-lead trigger keys push notifications to it.
const CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  // Bare 8-digit DK number → +45 prefix.
  if (/^\d{8}$/.test(digits)) return `+45${digits}`;
  // Already has country digits but no +, accept as-is with leading +.
  if (digits.length >= 10) return `+${digits}`;
  return null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const rawPhone = (body.phone ?? "").trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : null;

  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "valid email required" }, { status: 400 });
  if (!rawPhone) return NextResponse.json({ error: "phone required" }, { status: 400 });
  if (!phone) return NextResponse.json({ error: "phone format invalid" }, { status: 400 });

  const supabase = createAdminClient();
  const userAgent = req.headers.get("user-agent")?.slice(0, 300) ?? null;
  const referer = req.headers.get("referer")?.slice(0, 300) ?? null;

  const { data: row, error: insErr } = await supabase
    .from("quiz_submissions")
    .insert({
      name,
      email,
      phone,
      url: body.url ?? null,
      monthly_leads: body.monthlyLeads ?? null,
      deal_value: body.dealValue ?? null,
      close_rate: body.closeRate ?? null,
      response_time: body.responseTime ?? null,
      channels: body.channels ?? null,
      total_loss: body.totalLoss ?? null,
      // DB columns kept (no migration); the new three-machine fields map
      // to existing columns: speed_loss = hastighed, close_rate_loss =
      // opfølgning, channel_loss = outbound.
      speed_loss: body.hastighedLoss ?? null,
      close_rate_loss: body.opfølgningLoss ?? null,
      channel_loss: body.outboundLoss ?? null,
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

  // Mirror into `leads` so the existing notify-new-lead DB trigger fires
  // push notifications + the lead shows up in /leads. Failure non-fatal.
  try {
    await supabase.from("leads").insert({
      name,
      email,
      phone,
      source: "quiz",
      page_url: referer,
      user_agent: userAgent,
      monthly_leads:
        body.monthlyLeads != null ? String(body.monthlyLeads) : null,
      response_time: body.responseTime ?? null,
      workspace_id: CARTERCO_WORKSPACE_ID,
      is_draft: false,
    });
  } catch (e) {
    console.error("quiz-submit: leads-mirror failed", e);
  }

  // Auto-SMS removed 2026-05-22 — Phase 1 of the SMS rebuild. All
  // outgoing SMS is now operator-triggered from /leads via Louis's
  // personal iPhone (Phase 2). Lead row is still saved + mirrored to
  // /leads, just no auto-text on submission.

  return NextResponse.json({ ok: true, id: row.id });
}
