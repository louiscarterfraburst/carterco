import { describe, expect, it } from "vitest";
import {
  BOOKING_URL,
  FLEX_BOOKING_URL,
  bookingUrl,
  flexBookingUrl,
  scopingToken,
} from "./booking";

describe("bookingUrl (existing contact-form path, regression)", () => {
  it("returns the bare URL with no opts", () => {
    expect(bookingUrl()).toBe(BOOKING_URL);
  });

  it("prefills name/email and folds company+phone into notes", () => {
    const url = new URL(
      bookingUrl({ name: "Lone", email: "lone@firma.dk", phone: "12345678", company: "Firma" }),
    );
    expect(url.searchParams.get("name")).toBe("Lone");
    expect(url.searchParams.get("email")).toBe("lone@firma.dk");
    expect(url.searchParams.get("notes")).toBe("Firma: Firma · Tlf: 12345678");
  });
});

describe("flexBookingUrl (Lead Flex persist-then-book)", () => {
  it("puts only the scoping token in notes", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const url = new URL(flexBookingUrl({ scopingId: id }));
    expect(url.origin + url.pathname).toBe(FLEX_BOOKING_URL);
    expect(url.searchParams.get("notes")).toBe(`scoping:${id}`);
    expect(url.searchParams.get("name")).toBeNull();
    expect(url.searchParams.get("email")).toBeNull();
  });

  it("carries utm params when provided", () => {
    const url = new URL(
      flexBookingUrl({
        scopingId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        utm_source: "carterco.dk",
        utm_medium: "scoping",
      }),
    );
    expect(url.searchParams.get("utm_source")).toBe("carterco.dk");
    expect(url.searchParams.get("utm_medium")).toBe("scoping");
  });

  it("scopingToken formats the token the webhook regex expects", () => {
    expect(scopingToken("abc")).toBe("scoping:abc");
  });
});
