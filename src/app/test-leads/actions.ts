"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";

export async function markSubmitted(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const submittedBy = formData.get("submitted_by");
  const notes = formData.get("notes");
  if (typeof id !== "string" || !id) throw new Error("missing id");

  const sb = createAdminClient();
  const { error } = await sb
    .from("test_submissions")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      submitted_by: typeof submittedBy === "string" ? submittedBy || null : null,
      notes: typeof notes === "string" ? notes || null : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/test-leads");
}

export async function markSkipped(formData: FormData): Promise<void> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) throw new Error("missing id");
  const sb = createAdminClient();
  const { error } = await sb
    .from("test_submissions")
    .update({ status: "skipped", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/test-leads");
}

export async function assignResponse(formData: FormData): Promise<void> {
  const responseId = formData.get("response_id");
  const submissionId = formData.get("submission_id");
  if (typeof responseId !== "string" || !responseId) {
    throw new Error("missing response_id");
  }
  if (typeof submissionId !== "string" || !submissionId) {
    throw new Error("missing submission_id");
  }
  const sb = createAdminClient();
  const { error } = await sb
    .from("test_responses")
    .update({ submission_id: submissionId, matched_via: "manual" })
    .eq("id", responseId);
  if (error) throw new Error(error.message);
  revalidatePath("/test-leads");
}
