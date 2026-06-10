import { describe, expect, it } from "vitest";
import {
  autoRenderEnabled,
  getDefaultPlayId,
  getPlayConfig,
  hookAllowed,
  playPaused,
  playPausedLive,
  playStamp,
  type PlayConfig,
  type PlayLookup,
} from "../../../supabase/functions/_shared/plays";

// plays.ts is a Deno module, but its only non-relative import is type-only
// (erased at transform), so vitest can exercise it directly — same trick as
// background-status.test.ts. These are the safety policies of the play
// registry: hook gating fails CLOSED, pause gating fails OPEN, and playStamp
// must never clobber a real tag with null.

function config(overrides: Partial<PlayConfig> = {}): PlayConfig {
  return {
    id: "lead_flow",
    workspace_id: null,
    label: "Lead flow",
    status: "active",
    is_default: true,
    trigger_sequence_id: null,
    dm_template: null,
    use_personalized_hook: true,
    auto_render: false,
    ...overrides,
  };
}

// Minimal structural mock of the SupabaseClient query chain getPlayConfig
// uses: from().select().or().or() → { data, error }. Each call is recorded so
// cache behavior is observable.
function mockClient(responses: Array<{ data?: PlayConfig[]; error?: { message: string } }>) {
  let calls = 0;
  const client = {
    from() {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls++;
      const chain = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        then: (resolve: (v: { data: PlayConfig[] | null; error: { message: string } | null }) => void) =>
          resolve({ data: response.data ?? null, error: response.error ?? null }),
      };
      return chain;
    },
    callCount: () => calls,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

// getPlayConfig caches per `${workspace}:${playId}` in module state, so every
// test uses a unique workspace id to stay isolated. Ids must be UUID-shaped —
// getPlayConfig rejects malformed workspace ids (PostgREST filter-injection
// guard) before ever querying.
let wsCounter = 0;
const freshWs = () => `00000000-0000-4000-8000-${String(++wsCounter).padStart(12, "0")}`;

describe("getPlayConfig", () => {
  it("workspace-specific row overrides the global row with the same id", async () => {
    const ws = freshWs();
    const client = mockClient([
      { data: [config({ workspace_id: null, dm_template: "global" }), config({ workspace_id: ws, dm_template: "ws" })] },
    ]);
    const lookup = await getPlayConfig(client, "lead_flow", ws);
    expect(lookup).toEqual({ ok: true, config: expect.objectContaining({ dm_template: "ws" }) });
  });

  it("the named play wins over the default fallback", async () => {
    const ws = freshWs();
    const client = mockClient([
      { data: [config({ id: "lead_flow", is_default: true }), config({ id: "hiring", is_default: false })] },
    ]);
    const lookup = await getPlayConfig(client, "hiring", ws);
    expect(lookup.ok && lookup.config?.id).toBe("hiring");
  });

  it("resolves a named play with no registry row to config:null — NOT the default's config", async () => {
    // Inheriting the default play's config here would mean pausing the
    // default also pauses every unregistered-play lead, and the default's
    // dm_template/hook flag would silently apply to unknown plays.
    const ws = freshWs();
    const client = mockClient([{ data: [config({ id: "lead_flow", is_default: true })] }]);
    const lookup = await getPlayConfig(client, "ghost_play", ws);
    expect(lookup).toEqual({ ok: true, config: null });
  });

  it("rejects a malformed play id without querying (filter-injection guard)", async () => {
    const client = mockClient([{ data: [config()] }]);
    const lookup = await getPlayConfig(client, "evil),workspace_id.not.is.null,(", freshWs());
    expect(lookup).toEqual({ ok: true, config: null });
    expect(client.callCount()).toBe(0);
  });

  it("returns ok:false on query error and negative-caches it briefly", async () => {
    // A registry outage must cost ~one failed query per key per few seconds,
    // not one per pipeline row (the engagement-tick scan touches 500 rows).
    const ws = freshWs();
    const client = mockClient([
      { error: { message: "connection refused" } },
      { data: [config()] },
    ]);
    expect(await getPlayConfig(client, "lead_flow", ws)).toEqual({ ok: false });
    // Within the negative-cache window the error is served from cache.
    expect(await getPlayConfig(client, "lead_flow", ws)).toEqual({ ok: false });
    expect(client.callCount()).toBe(1);
  });

  it("serves repeat lookups from the TTL cache without a second query", async () => {
    const ws = freshWs();
    const client = mockClient([{ data: [config()] }]);
    await getPlayConfig(client, "lead_flow", ws);
    await getPlayConfig(client, "lead_flow", ws);
    expect(client.callCount()).toBe(1);
  });
});

describe("getDefaultPlayId", () => {
  it("returns the default play's id", async () => {
    const client = mockClient([{ data: [config({ id: "lead_flow", is_default: true })] }]);
    expect(await getDefaultPlayId(client, freshWs())).toBe("lead_flow");
  });

  it("returns null on lookup error — callers must skip, loudly", async () => {
    const client = mockClient([{ error: { message: "boom" } }]);
    expect(await getDefaultPlayId(client, freshWs())).toBeNull();
  });

  it("returns null when the registry has no default play", async () => {
    const client = mockClient([{ data: [] }]);
    expect(await getDefaultPlayId(client, freshWs())).toBeNull();
  });
});

describe("hookAllowed — fails CLOSED", () => {
  it("a failed lookup disables the hook (never send a hook a play banned)", () => {
    expect(hookAllowed({ ok: false })).toBe(false);
  });

  it("no registry row behaves like a default play: hook on", () => {
    expect(hookAllowed({ ok: true, config: null })).toBe(true);
  });

  it("respects the registry opt-out", () => {
    expect(hookAllowed({ ok: true, config: config({ use_personalized_hook: false }) })).toBe(false);
    expect(hookAllowed({ ok: true, config: config({ use_personalized_hook: true }) })).toBe(true);
  });
});

describe("autoRenderEnabled — fails CLOSED", () => {
  it("a failed lookup keeps the manual pre-render gate (never burn a SendSpark render on a registry blip)", () => {
    expect(autoRenderEnabled({ ok: false })).toBe(false);
  });

  it("no registry row keeps the manual gate — auto-render is strictly opt-in", () => {
    expect(autoRenderEnabled({ ok: true, config: null })).toBe(false);
  });

  it("fires only when the registry row opts in", () => {
    expect(autoRenderEnabled({ ok: true, config: config({ auto_render: true }) })).toBe(true);
    expect(autoRenderEnabled({ ok: true, config: config({ auto_render: false }) })).toBe(false);
  });
});

describe("playPaused — fails OPEN", () => {
  it("a failed lookup does NOT pause (a registry blip must not stall every play)", () => {
    expect(playPaused({ ok: false })).toBe(false);
  });

  it("pauses only when the registry says paused", () => {
    expect(playPaused({ ok: true, config: config({ status: "paused" }) })).toBe(true);
    expect(playPaused({ ok: true, config: config({ status: "active" }) })).toBe(false);
    expect(playPaused({ ok: true, config: null })).toBe(false);
  });
});

describe("playPausedLive — cache-bypassing kill switch for the drainer", () => {
  it("sees a pause immediately: every call queries, never the TTL cache", async () => {
    const ws = freshWs();
    const client = mockClient([
      { data: [config({ status: "active" })] },
      { data: [config({ status: "paused" })] },
    ]);
    expect(await playPausedLive(client, "lead_flow", ws)).toBe(false);
    // Second call must hit the DB again and see the freshly-flipped pause.
    expect(await playPausedLive(client, "lead_flow", ws)).toBe(true);
    expect(client.callCount()).toBe(2);
  });

  it("workspace override beats the global row", async () => {
    const ws = freshWs();
    const client = mockClient([
      { data: [config({ workspace_id: null, status: "active" }), config({ workspace_id: ws, status: "paused" })] },
    ]);
    expect(await playPausedLive(client, "lead_flow", ws)).toBe(true);
  });

  it("fails OPEN on query error — a registry blip must not freeze the queue", async () => {
    const client = mockClient([{ error: { message: "connection refused" } }]);
    expect(await playPausedLive(client, "lead_flow", freshWs())).toBe(false);
  });

  it("fails open without querying for empty or malformed ids (filter-injection guard)", async () => {
    const client = mockClient([{ data: [config({ status: "paused" })] }]);
    expect(await playPausedLive(client, "", freshWs())).toBe(false);
    expect(await playPausedLive(client, "evil),x.eq.(", freshWs())).toBe(false);
    expect(await playPausedLive(client, "lead_flow", "not-a-uuid")).toBe(false);
    expect(client.callCount()).toBe(0);
  });

  it("no registry row at all is not paused", async () => {
    const client = mockClient([{ data: [] }]);
    expect(await playPausedLive(client, "ghost_play", freshWs())).toBe(false);
  });
});

describe("playStamp — never clobber a real tag", () => {
  it("stamps a real play", () => {
    expect(playStamp({ play: "hiring" })).toEqual({ play: "hiring" });
  });

  it("omits the column entirely for unknown plays so upsert-on-conflict keeps the existing tag", () => {
    expect(playStamp(null)).toEqual({});
    expect(playStamp(undefined)).toEqual({});
    expect(playStamp({ play: null })).toEqual({});
    expect(playStamp({ play: "   " })).toEqual({});
    expect(playStamp({})).toEqual({});
  });
});
