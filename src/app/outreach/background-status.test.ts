import { describe, expect, it } from "vitest";
import { classifyBackground } from "../../../supabase/functions/_shared/background";

// The Victor Lisberg case: SendSpark was given revatacarbon.com but rendered
// the CarterCo-branded landing as the video background, and nothing flagged
// it before the approval queue. classifyBackground is the detection half;
// sendspark-webhook parks 'fallback' rows instead of queueing them.
describe("classifyBackground", () => {
  it("returns ok when rendered host matches requested host", () => {
    expect(
      classifyBackground({
        originalBackgroundUrl: "https://revatacarbon.com",
        backgroundUrl: "https://revatacarbon.com",
      }),
    ).toBe("ok");
  });

  it("ignores protocol, www and path differences (SendSpark rewrites URLs)", () => {
    expect(
      classifyBackground({
        originalBackgroundUrl: "revatacarbon.com",
        backgroundUrl: "https://www.revatacarbon.com/screenshot?w=1280",
      }),
    ).toBe("ok");
  });

  it("returns fallback when SendSpark rendered a different site", () => {
    expect(
      classifyBackground({
        originalBackgroundUrl: "https://revatacarbon.com",
        backgroundUrl: "https://carterco.dk",
      }),
    ).toBe("fallback");
  });

  it("returns unknown when the payload exposes no background URLs", () => {
    expect(classifyBackground({})).toBe("unknown");
    expect(classifyBackground({ backgroundUrl: "https://carterco.dk" })).toBe("unknown");
    expect(classifyBackground({ originalBackgroundUrl: "https://revatacarbon.com" })).toBe("unknown");
  });

  it("returns unknown for unparseable URLs rather than guessing", () => {
    expect(
      classifyBackground({
        originalBackgroundUrl: "not a url at all ::",
        backgroundUrl: "https://carterco.dk",
      }),
    ).toBe("unknown");
  });

  it("treats empty strings as missing", () => {
    expect(classifyBackground({ originalBackgroundUrl: "", backgroundUrl: "" })).toBe("unknown");
  });
});
