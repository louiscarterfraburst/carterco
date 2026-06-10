import { describe, expect, it } from "vitest";
import { flowTimeAgo, normLinkedinUrl, stagedLeadStage, type StageMarks } from "./flow";

function marks(overrides: Partial<StageMarks> = {}): StageMarks {
  return { last_reply_at: null, sent_at: null, accepted_at: null, invited_at: null, ...overrides };
}

const URL = "https://linkedin.com/in/mette-hansen";

describe("normLinkedinUrl", () => {
  it("strips trailing slashes and query params and lowercases — scraper variants must collide", () => {
    expect(normLinkedinUrl("https://LinkedIn.com/in/Mette-Hansen/?utm=x")).toBe(URL);
    expect(normLinkedinUrl("https://linkedin.com/in/mette-hansen//")).toBe(URL);
    expect(normLinkedinUrl(null)).toBe("");
  });
});

describe("stagedLeadStage", () => {
  it("is Klargjort when the lead has no pipeline row yet", () => {
    expect(stagedLeadStage({ linkedin_url: URL }, new Map())).toBe("Klargjort");
  });

  it("walks the stage ladder by the strongest signal present", () => {
    const stage = (m: StageMarks) =>
      stagedLeadStage({ linkedin_url: URL }, new Map([[URL, m]]));
    expect(stage(marks({ invited_at: "t" }))).toBe("Inviteret");
    expect(stage(marks({ invited_at: "t", accepted_at: "t" }))).toBe("Accepteret");
    expect(stage(marks({ accepted_at: "t", sent_at: "t" }))).toBe("Video");
    expect(stage(marks({ sent_at: "t", last_reply_at: "t" }))).toBe("Svar");
    expect(stage(marks())).toBe("Klargjort");
  });

  it("matches the pipeline row through URL normalization", () => {
    const pipeByUrl = new Map([[URL, marks({ invited_at: "t" })]]);
    expect(
      stagedLeadStage({ linkedin_url: "https://LinkedIn.com/in/Mette-Hansen/?src=li" }, pipeByUrl),
    ).toBe("Inviteret");
  });
});

describe("flowTimeAgo", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("renders minutes under an hour, hours under a day, then days", () => {
    expect(flowTimeAgo(ago(45 * 60_000))).toBe("45 min");
    expect(flowTimeAgo(ago(3 * 3_600_000))).toBe("3 t");
    expect(flowTimeAgo(ago(6 * 86_400_000))).toBe("6 d");
  });

  it("clamps future timestamps to 0 min and renders empty for null", () => {
    expect(flowTimeAgo(ago(-5 * 60_000))).toBe("0 min");
    expect(flowTimeAgo(null)).toBe("");
  });
});
