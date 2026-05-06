// Lead-quiz contact gate. Called from the LeadQuiz component after the
// user fills the contact step (name + email required, phone optional).
// Persists the submission, then fires an outbound SMS if a phone was given
// so the prospect gets a callback offer within minutes.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { sendTwilioSMS } from "@/app/api/twilio/_helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  email?: string;
  phone?: string;
  url?: string;
  monthlyLeads?: number;
  dealValue?: number;
  closeRate?: number;
  responseTime?: string;
  channels?: string[];
  totalLoss?: number;
  speedLoss?: number;
  closeRateLoss?: number;
  channelLoss?: number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function formatKr(value: number): string {
  return Math.round(value).toLocaleString("da-DK") + " kr";
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
  if (rawPhone && !phone) return NextResponse.json({ error: "phone format invalid" }, { status: 400 });

  const supabase = createAdminClient();

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
      speed_loss: body.speedLoss ?? null,
      close_rate_loss: body.closeRateLoss ?? null,
      channel_loss: body.channelLoss ?? null,
      user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      referrer: req.headers.get("referer")?.slice(0, 300) ?? null,
    })
    .select("id")
    .single();

  if (insErr || !row) {
    return NextResponse.json(
      { error: "db insert failed", details: insErr?.message },
      { status: 500 },
    );
  }

  // Fire SMS if a phone was given. Failure here is non-fatal — the submission
  // is already saved and the user still gets the result.
  if (phone) {
    const firstName = name.split(/\s+/)[0] ?? name;
    const lossLine = body.totalLoss
      ? `Dine tal viser ca. ${formatKr(body.totalLoss)}/md i tabt potentiale. `
      : "";
    const smsBody =
      `Hej ${firstName}, det er Louis fra Carter & Co. ${lossLine}` +
      `Skal vi tage 15 min i denne uge og kigge på de konkrete huller? ` +
      `Skriv tilbage med en tid der passer.`;
    try {
      const sid = await sendTwilioSMS(phone, smsBody);
      await supabase
        .from("quiz_submissions")
        .update({ sms_sid: sid, sms_sent_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase
        .from("quiz_submissions")
        .update({ sms_error: msg.slice(0, 500) })
        .eq("id", row.id);
    }
  }

  return NextResponse.json({ ok: true, id: row.id });
}
