import { describe, expect, it } from "vitest";
import { parseFieldData } from "./meta-lead-fields.ts";

const fd = (entries: Array<[string, string]>) =>
  entries.map(([name, value]) => ({ name, values: [value] }));

describe("parseFieldData", () => {
  it("maps Meta's standard English keys (CR New-copy / K9 forms)", () => {
    const out = parseFieldData(fd([
      ["antal_deltagere", "8"],
      ["full_name", "Mette Hansen"],
      ["company_name", "Hansen ApS"],
      ["phone_number", "+4520112233"],
      ["email", "Mette@Hansen.dk"],
    ]));
    expect(out.name).toBe("Mette Hansen");
    expect(out.company).toBe("Hansen ApS");
    expect(out.phone).toBe("+4520112233");
    expect(out.email).toBe("mette@hansen.dk");
    expect(out.qualifier).toBe("8");
  });

  it("maps the Danish keys on Soho's Office-carter form", () => {
    const out = parseFieldData(fd([
      ["antal_medarbejdere", "12"],
      ["ønsket_dato_for_indflytning", "1. august"],
      ["fulde_navn", "Jonas Holm"],
      ["virksomhedsnavn", "Holm & Partnere"],
      ["telefonnummer", "+4526554477"],
      ["e-mail", "jh@holmpartnere.dk"],
    ]));
    expect(out.name).toBe("Jonas Holm");
    expect(out.company).toBe("Holm & Partnere");
    expect(out.phone).toBe("+4526554477");
    expect(out.email).toBe("jh@holmpartnere.dk");
    expect(out.qualifier).toBe("12");
    expect(out.extra["ønsket_dato_for_indflytning"]).toBe("1. august");
  });

  it("combines first_name + last_name when no full name field exists", () => {
    const out = parseFieldData(fd([
      ["first_name", "Sofie"],
      ["last_name", "Lund"],
      ["email", "sofie@dbnord.dk"],
    ]));
    expect(out.name).toBe("Sofie Lund");
  });

  it("skips empty values and tolerates missing field_data", () => {
    expect(parseFieldData(undefined).name).toBeNull();
    const out = parseFieldData(fd([["full_name", "  "], ["email", "a@b.dk"]]));
    expect(out.name).toBeNull();
    expect(out.email).toBe("a@b.dk");
  });
});
