"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";

const SLUG_RE = /^[a-z0-9-]{8,64}$/;

function assertSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Error("invalid slug");
  }
}

export async function saveItem(formData: FormData): Promise<void> {
  const slug = formData.get("slug");
  const itemId = formData.get("item_id");
  const value = formData.get("value");
  const completed = formData.get("completed");

  assertSlug(slug);
  if (typeof itemId !== "string" || !itemId) throw new Error("missing item_id");

  const sb = createAdminClient();

  const { data: eng, error: engErr } = await sb
    .from("setup_engagements")
    .select("id, status")
    .eq("slug", slug)
    .maybeSingle();
  if (engErr) throw new Error(engErr.message);
  if (!eng) throw new Error("engagement not found");
  if (eng.status !== "open") throw new Error("engagement is closed");

  const patch: Record<string, unknown> = {};
  if (value !== null) patch.value = typeof value === "string" ? value : null;
  if (completed !== null) {
    const isDone = completed === "true" || completed === "on";
    patch.completed = isDone;
    patch.completed_at = isDone ? new Date().toISOString() : null;
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await sb
    .from("setup_items")
    .update(patch)
    .eq("id", itemId)
    .eq("engagement_id", eng.id);
  if (error) throw new Error(error.message);

  revalidatePath(`/setup/${slug}`);
}

export async function completeEngagement(formData: FormData): Promise<void> {
  const slug = formData.get("slug");
  assertSlug(slug);

  const sb = createAdminClient();
  const now = new Date().toISOString();

  const { data: eng, error: engErr } = await sb
    .from("setup_engagements")
    .update({ status: "completed", completed_at: now })
    .eq("slug", slug)
    .eq("status", "open")
    .select("id, client_name, contact_name, contact_email")
    .maybeSingle();
  if (engErr) throw new Error(engErr.message);
  if (!eng) throw new Error("engagement not found or already closed");

  // Notify Louis. Best-effort — completion succeeds even if the webhook fails.
  const webhook = process.env.SETUP_NOTIFY_SLACK_WEBHOOK;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `:white_check_mark: Setup-portal færdig: *${eng.client_name}* (${eng.contact_name ?? "?"}, ${eng.contact_email ?? "?"}) — /setup/${slug}`,
        }),
      });
      await sb
        .from("setup_engagements")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", eng.id);
    } catch {
      // swallow — the client doesn't need to know if Slack is down
    }
  }

  revalidatePath(`/setup/${slug}`);
}
