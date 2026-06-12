import { describe, expect, it } from "vitest";
import { mailComposeUrl, normalizeMailProvider, opensInNewTab } from "./mail-compose";

describe("mailComposeUrl", () => {
  it("builds a Gmail web compose link", () => {
    const url = mailComposeUrl("gmail", "mette@hansen.dk", "Hej Mette", "Linje 1\nLinje 2");
    expect(url).toBe(
      "https://mail.google.com/mail/?view=cm&fs=1&to=mette%40hansen.dk&su=Hej%20Mette&body=Linje%201%0ALinje%202",
    );
  });

  it("builds an Outlook web compose link (Soho is M365)", () => {
    const url = mailComposeUrl("outlook", "mette@hansen.dk", "Hej", "Tekst");
    expect(url).toBe(
      "https://outlook.office.com/mail/deeplink/compose?to=mette%40hansen.dk&subject=Hej&body=Tekst",
    );
  });

  it("falls back to mailto for default/unknown providers", () => {
    expect(mailComposeUrl("mailto", "a@b.dk", "S", "B")).toBe("mailto:a@b.dk?subject=S&body=B");
    expect(mailComposeUrl(null, "a@b.dk", "S", "B")).toBe("mailto:a@b.dk?subject=S&body=B");
    expect(mailComposeUrl("hotmail", "a@b.dk", "S", "B")).toBe("mailto:a@b.dk?subject=S&body=B");
  });
});

describe("normalizeMailProvider / opensInNewTab", () => {
  it("normalizes unknown values to mailto", () => {
    expect(normalizeMailProvider("gmail")).toBe("gmail");
    expect(normalizeMailProvider("outlook")).toBe("outlook");
    expect(normalizeMailProvider("yahoo")).toBe("mailto");
    expect(normalizeMailProvider(undefined)).toBe("mailto");
  });

  it("web composers open in a new tab, mailto stays in place", () => {
    expect(opensInNewTab("gmail")).toBe(true);
    expect(opensInNewTab("outlook")).toBe(true);
    expect(opensInNewTab("mailto")).toBe(false);
    expect(opensInNewTab(null)).toBe(false);
  });
});
