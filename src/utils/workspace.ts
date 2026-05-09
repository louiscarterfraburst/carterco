import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

export type Workspace = { id: string; name: string };

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
      .select("id, name")
      .order("name", { ascending: true })
      .then(({ data }) => {
        if (cancelled) return;
        setState({
          userId: user.id,
          workspaces: (data ?? []).map((w) => ({ id: w.id, name: w.name })),
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
