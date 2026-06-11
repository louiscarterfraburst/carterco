import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable holder so each test installs its own fake admin client.
const holder: { client: unknown } = { client: null };
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => holder.client,
}));

import { POST } from "./route";

type Call = { table: string; payload: Record<string, unknown> };

function makeFakeClient(opts: { existingLeads?: Array<{ id: string; notes: string | null }> } = {}) {
  const inserts: Call[] = [];
  const updates: Call[] = [];
  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          return {
            select: () => ({
              single: async () => ({
                data: { id: table === "scoping_submissions" ? "0f8fad5b-d9cb-469f-a165-70867728950e" : "lead-1" },
                error: null,
              }),
            }),
          };
        },
        select() {
          return {
            eq: () => ({
              ilike: () => ({
                limit: async () => ({ data: opts.existingLeads ?? [], error: null }),
              }),
            }),
          };
        },
        update(payload: Record<string, unknown>) {
          updates.push({ table, payload });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { client, inserts, updates };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/quiz-submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const VALID_ICP = "Vi sælger engros rengøringsartikler til hoteller";

describe("POST /api/quiz-submit (scoping contract)", () => {
  beforeEach(() => {
    holder.client = makeFakeClient().client;
  });

  it("rejects invalid json", async () => {
    const res = await POST(
      new Request("http://localhost/api/quiz-submit", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown kind", async () => {
    const res = await post({ kind: "quiz", icp: VALID_ICP });
    expect(res.status).toBe(400);
  });

  it("rejects too-short icp", async () => {
    const res = await post({ kind: "booking", icp: "aaa" });
    expect(res.status).toBe(400);
  });

  it("honeypot: pretends success and writes nothing", async () => {
    const fake = makeFakeClient();
    holder.client = fake.client;
    const res = await post({ kind: "booking", icp: VALID_ICP, website: "spam.com" });
    expect(res.status).toBe(200);
    expect(fake.inserts).toHaveLength(0);
  });

  it("booking: persists an anonymous scoping row and returns its id", async () => {
    const fake = makeFakeClient();
    holder.client = fake.client;
    const res = await post({ kind: "booking", icp: VALID_ICP, tried: ["Købte lister"], locale: "da" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id?: string };
    expect(data.id).toBeTruthy();
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].table).toBe("scoping_submissions");
    expect(fake.inserts[0].payload.kind).toBe("booking");
    expect(fake.inserts[0].payload.email).toBeNull();
    expect(fake.inserts[0].payload.consent).toBe(false);
  });

  it("soft_capture: rejects missing email", async () => {
    const res = await post({ kind: "soft_capture", icp: VALID_ICP, consent: true });
    expect(res.status).toBe(400);
  });

  it("soft_capture: rejects missing consent", async () => {
    const res = await post({ kind: "soft_capture", icp: VALID_ICP, email: "a@b.dk" });
    expect(res.status).toBe(400);
  });

  it("soft_capture: inserts scoping row + mirrors a new lead", async () => {
    const fake = makeFakeClient();
    holder.client = fake.client;
    const res = await post({
      kind: "soft_capture",
      icp: VALID_ICP,
      tried: ["Selv på LinkedIn"],
      email: "ny@firma.dk",
      consent: true,
    });
    expect(res.status).toBe(200);
    const tables = fake.inserts.map((c) => c.table);
    expect(tables).toContain("scoping_submissions");
    expect(tables).toContain("leads");
    const lead = fake.inserts.find((c) => c.table === "leads")!;
    expect(lead.payload.source).toBe("flex_soft_capture");
    expect(String(lead.payload.notes)).toContain("ICP:");
  });

  it("soft_capture: dedupes by email — updates the existing lead instead of inserting", async () => {
    const fake = makeFakeClient({ existingLeads: [{ id: "lead-9", notes: "gammel note" }] });
    holder.client = fake.client;
    const res = await post({
      kind: "soft_capture",
      icp: VALID_ICP,
      email: "kendt@firma.dk",
      consent: true,
    });
    expect(res.status).toBe(200);
    expect(fake.inserts.filter((c) => c.table === "leads")).toHaveLength(0);
    const leadUpdate = fake.updates.find((c) => c.table === "leads");
    expect(leadUpdate).toBeTruthy();
    expect(String(leadUpdate!.payload.notes)).toContain("gammel note");
    expect(String(leadUpdate!.payload.notes)).toContain("ICP:");
  });
});
