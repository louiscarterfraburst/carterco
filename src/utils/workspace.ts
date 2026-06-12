import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

export type Workspace = {
  id: string;
  name: string;
  sms_enabled?: boolean;
  booking_url?: string | null;
  signoff?: string | null;
  outcome_preset?: string | null;
  // Workspace-owned no-answer SMS message ({fornavn}/{medarbejder}/{brand}/
  // {booking}/{slots} tokens). NULL = built-in default in leads/messages.ts.
  sms_template?: string | null;
  // First-message mechanism (video_render | ai_drafted_dm) — drives the Flow
  // board's main spine in /outreach.
  outreach_style?: string | null;
  // Where "Skriv mail" opens the draft: mailto | gmail | outlook.
  mail_provider?: string | null;
};

// Returns the workspaces the authenticated user is a member of. RLS filters the
// query to only workspaces where the current JWT email is a member.
export function useWorkspace(
  supabase: SupabaseClient,
  user: User | null,
): { workspace: Workspace | null; workspaces: Workspace[]; loading: boolean } {
  const [state, setState] = useState<{
    userId: string | null;
    workspaces: Workspace[];
  }>({ userId: null, workspaces: [] });

  useEffect(() => {
    let cancelled = false;
    if (!user) return;

    void supabase
      .from("workspaces")
      .select("id, name, sms_enabled, booking_url, signoff, outcome_preset, sms_template, outreach_style, mail_provider")
      .order("name", { ascending: true })
      .then(({ data }) => {
        if (cancelled) return;
        setState({
          userId: user.id,
          workspaces: (data ?? []).map((w) => ({
            id: w.id,
            name: w.name,
            sms_enabled: w.sms_enabled ?? false,
            booking_url: w.booking_url ?? null,
            signoff: w.signoff ?? null,
            outcome_preset: w.outcome_preset ?? "standard",
            sms_template: w.sms_template ?? null,
            outreach_style: w.outreach_style ?? "video_render",
            mail_provider: w.mail_provider ?? "mailto",
          })),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, user]);

  if (!user) return { workspace: null, workspaces: [], loading: false };

  const workspaces = state.userId === user.id ? state.workspaces : [];

  return {
    workspace: workspaces[0] ?? null,
    workspaces,
    loading: state.userId !== user.id,
  };
}
