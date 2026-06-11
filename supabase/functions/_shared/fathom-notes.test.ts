import { describe, expect, it } from "vitest";
import {
  buildTranscriptText,
  durationMinutes,
  externalInviteeEmails,
  matchLeadByMeetingTime,
  MEETING_MATCH_TOLERANCE_MS,
  noteSubject,
  SIGNATURE_TOLERANCE_SECONDS,
  truncateTranscript,
  verifyFathomSignature,
} from "./fathom-notes";

describe("externalInviteeEmails", () => {
  it("returns lowercased external emails only", () => {
    const emails = externalInviteeEmails([
      { email: "Louis@carterco.dk", is_external: false },
      { email: "Nikolaj@Bikenor.dk", is_external: true },
      { email: "cfo@bikenor.dk", is_external: true },
    ]);
    expect(emails).toEqual(["nikolaj@bikenor.dk", "cfo@bikenor.dk"]);
  });
  it("skips missing emails and dedupes", () => {
    const emails = externalInviteeEmails([
      { email: null, is_external: true },
      { email: "  ", is_external: true },
      { email: "a@b.dk", is_external: true },
      { email: "A@B.dk", is_external: true },
    ]);
    expect(emails).toEqual(["a@b.dk"]);
  });
});

describe("buildTranscriptText", () => {
  it("prefixes each line with the speaker name", () => {
    const text = buildTranscriptText([
      { speaker: { display_name: "Louis Carter" }, text: "Hej, kan du høre mig?" },
      { speaker: { display_name: "Nikolaj" }, text: "Ja, fint." },
    ]);
    expect(text).toBe("Louis Carter: Hej, kan du høre mig?\nNikolaj: Ja, fint.");
  });

  it("merges consecutive segments from the same speaker", () => {
    const text = buildTranscriptText([
      { speaker: { display_name: "Louis Carter" }, text: "Et øjeblik." },
      { speaker: { display_name: "Louis Carter" }, text: "Så er jeg klar." },
      { speaker: { display_name: "Nikolaj" }, text: "Super." },
    ]);
    expect(text).toBe(
      "Louis Carter: Et øjeblik. Så er jeg klar.\nNikolaj: Super.",
    );
  });

  it("skips empty segments and handles unnamed speakers", () => {
    const text = buildTranscriptText([
      { speaker: { display_name: "Louis Carter" }, text: "  " },
      { speaker: { display_name: null }, text: "Hallo?" },
      { text: "Uden afsender." },
    ]);
    expect(text).toBe("Ukendt deltager: Hallo? Uden afsender.");
  });
});

describe("matchLeadByMeetingTime", () => {
  const at = (iso: string) => ({ id: iso, meeting_at: iso });

  it("matches a lead whose meeting_at is within tolerance", () => {
    const lead = at("2026-06-11T10:00:00Z");
    expect(matchLeadByMeetingTime([lead], "2026-06-11T10:07:00Z")).toBe(lead);
  });

  it("rejects a lead outside the tolerance window", () => {
    const lead = at("2026-06-11T10:00:00Z");
    const justOutside = new Date(
      Date.parse("2026-06-11T10:00:00Z") + MEETING_MATCH_TOLERANCE_MS + 60_000,
    ).toISOString();
    expect(matchLeadByMeetingTime([lead], justOutside)).toBeNull();
  });

  it("picks the closest lead when several are in window", () => {
    const close = at("2026-06-11T10:05:00Z");
    const far = at("2026-06-11T10:25:00Z");
    expect(matchLeadByMeetingTime([far, close], "2026-06-11T10:00:00Z")).toBe(
      close,
    );
  });

  it("returns null on a double-booked slot (tie)", () => {
    const a = { id: "a", meeting_at: "2026-06-11T10:00:00Z" };
    const b = { id: "b", meeting_at: "2026-06-11T10:00:00Z" };
    expect(matchLeadByMeetingTime([a, b], "2026-06-11T10:00:00Z")).toBeNull();
  });

  it("ignores leads without meeting_at and bad timestamps", () => {
    expect(matchLeadByMeetingTime([{ id: "a", meeting_at: null }], "2026-06-11T10:00:00Z"))
      .toBeNull();
    expect(matchLeadByMeetingTime([at("not-a-date")], "2026-06-11T10:00:00Z"))
      .toBeNull();
    expect(matchLeadByMeetingTime([at("2026-06-11T10:00:00Z")], "garbage"))
      .toBeNull();
  });
});

describe("durationMinutes", () => {
  it("rounds the span to whole minutes", () => {
    expect(
      durationMinutes("2026-06-11T10:00:00Z", "2026-06-11T10:32:20Z"),
    ).toBe(32);
  });
  it("returns null for missing or inverted timestamps", () => {
    expect(durationMinutes(null, "2026-06-11T10:00:00Z")).toBeNull();
    expect(durationMinutes("2026-06-11T10:00:00Z", null)).toBeNull();
    expect(
      durationMinutes("2026-06-11T11:00:00Z", "2026-06-11T10:00:00Z"),
    ).toBeNull();
  });
});

describe("noteSubject", () => {
  it("joins title and duration when known", () => {
    expect(noteSubject("Intro: Carter & Co x Bikenor", 32)).toBe(
      "Møde · Intro: Carter & Co x Bikenor · 32 min",
    );
  });
  it("omits missing pieces", () => {
    expect(noteSubject(null, 32)).toBe("Møde · 32 min");
    expect(noteSubject("  ", null)).toBe("Møde");
  });
});

describe("truncateTranscript", () => {
  it("leaves short transcripts untouched", () => {
    expect(truncateTranscript("kort", 100)).toBe("kort");
  });
  it("cuts long transcripts and marks the cut", () => {
    const out = truncateTranscript("a".repeat(50), 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out.endsWith("[transkript afkortet]")).toBe(true);
  });
});

describe("verifyFathomSignature", () => {
  // Mirror of the function's own signing path, used to mint valid fixtures.
  async function sign(id: string, ts: string, body: string, secret: string) {
    const raw = atob(secret.startsWith("whsec_") ? secret.slice(6) : secret);
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${ts}.${body}`),
    );
    return btoa(String.fromCharCode(...new Uint8Array(mac)));
  }

  const secret = `whsec_${btoa("test-secret-key-material")}`;
  const body = '{"recording_id":1}';
  const now = 1_780_000_000;
  const ts = String(now);

  it("accepts a valid v1 signature", async () => {
    const sig = await sign("msg_1", ts, body, secret);
    const ok = await verifyFathomSignature(
      { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
      body,
      secret,
      now,
    );
    expect(ok).toBe(true);
  });

  it("accepts when one of several space-delimited signatures matches", async () => {
    const sig = await sign("msg_1", ts, body, secret);
    const ok = await verifyFathomSignature(
      { id: "msg_1", timestamp: ts, signature: `v1,AAAA v1,${sig}` },
      body,
      secret,
      now,
    );
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign("msg_1", ts, body, secret);
    const ok = await verifyFathomSignature(
      { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
      '{"recording_id":2}',
      secret,
      now,
    );
    expect(ok).toBe(false);
  });

  it("rejects a stale timestamp (replay)", async () => {
    const sig = await sign("msg_1", ts, body, secret);
    const ok = await verifyFathomSignature(
      { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
      body,
      secret,
      now + SIGNATURE_TOLERANCE_SECONDS + 1,
    );
    expect(ok).toBe(false);
  });

  it("rejects missing headers and undecodable secrets", async () => {
    expect(
      await verifyFathomSignature(
        { id: null, timestamp: ts, signature: "v1,x" },
        body,
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      await verifyFathomSignature(
        { id: "msg_1", timestamp: ts, signature: "v1,x" },
        body,
        "whsec_!!!not-base64!!!",
        now,
      ),
    ).toBe(false);
  });
});
