// Per-client portal: shared, dependency-free helpers so the middleware
// (proxy.ts, edge runtime) and the app routes agree on slugs, cookies, and the
// cheap cookie hash. Keep this module pure — no node/server imports — so it's
// safe to bundle into the edge middleware.
//
// See docs/client-pipeline-view.md.

export type PortalClient = {
  slug: string;
  workspaceId: string;
  displayName: string;
};

// Workspace UUIDs mirror src/app/api/outreach/client-config/route.ts /
// supabase/functions/_shared/workspaces.ts. When you add a client, add it here.
export const PORTAL_CLIENTS: Record<string, PortalClient> = {
  tresyv: {
    slug: "tresyv",
    workspaceId: "2740ba1f-d5d5-4008-bf43-b45367c73134",
    displayName: "Tresyv",
  },
  odagroup: {
    slug: "odagroup",
    workspaceId: "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6",
    displayName: "Oda Group",
  },
};

export function portalClient(slug: string): PortalClient | null {
  return PORTAL_CLIENTS[slug] ?? null;
}

// Per-client password lives in env, e.g. PORTAL_PASSWORD_TRESYV. Keeping them
// separate means one client's link can't open another's view.
export function portalPasswordEnvVar(slug: string): string {
  return `PORTAL_PASSWORD_${slug.toUpperCase()}`;
}

export function portalCookieName(slug: string): string {
  return `portal_${slug}`;
}

export const PORTAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Cheap derived value (not cryptographic) — keeps the raw password out of the
// cookie. Same approach as the bikenor gate; fine for a low-stakes client view
// Louis controls. Mirrors proxy.ts bikenorHash so behaviour is identical.
export function portalHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `v1.${Math.abs(h).toString(36)}.${s.length}`;
}

export function portalSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
