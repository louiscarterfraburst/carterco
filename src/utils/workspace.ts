import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

export type Workspace = { id: string; name: string };

// Returns the first workspace the authenticated user is a member of. RLS
// filters the query to only workspaces where the current JWT email is a member.
export function useWorkspace(
  supabase: SupabaseClient,
  user: User | null,
): { workspace: Workspace | null; loading: boolean } {
  const [state, setState] = useState<{
    userId: string | null;
    workspace: Workspace | null;
  }>({ userId: null, workspace: null });

  useEffect(() => {
    let cancelled = false;
    if (!user) return;

    void supabase
      .from("workspaces")
      .select("id, name")
      .order("name", { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setState({
          userId: user.id,
          workspace: data ? { id: data.id, name: data.name } : null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, user]);

  if (!user) return { workspace: null, loading: false };

  return {
    workspace: state.userId === user.id ? state.workspace : null,
    loading: state.userId !== user.id,
  };
}
