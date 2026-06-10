import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PlayPills } from "./playUi";

// vitest doesn't auto-run RTL cleanup without globals:true.
afterEach(cleanup);

const PLAYS = [
  { id: "lead_flow", label: "Lead flow" },
  { id: "hiring_signal", label: "Hiring" },
];

const countFor = (id: string) => (id === "all" ? 12 : id === "lead_flow" ? 8 : 4);

describe("PlayPills", () => {
  it("renders nothing for a single-play workspace with no filter active", () => {
    const { container } = render(
      <PlayPills plays={[PLAYS[0]]} value="all" onChange={() => {}} countFor={countFor} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("still renders for a single-play workspace when a filter IS active — the user needs a way back to Alle", () => {
    render(<PlayPills plays={[PLAYS[0]]} value="lead_flow" onChange={() => {}} countFor={countFor} />);
    expect(screen.getByRole("button", { name: /Alle/ })).toBeTruthy();
  });

  it("renders an Alle pill plus one pill per play, each with its count", () => {
    render(<PlayPills plays={PLAYS} value="all" onChange={() => {}} countFor={countFor} />);
    expect(screen.getByRole("button", { name: /Alle\s*12/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lead flow\s*8/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hiring\s*4/ })).toBeTruthy();
  });

  it("clicking a pill reports that play id; clicking Alle reports 'all'", () => {
    const picked: string[] = [];
    render(<PlayPills plays={PLAYS} value="all" onChange={(id) => picked.push(id)} countFor={countFor} />);
    fireEvent.click(screen.getByRole("button", { name: /Hiring/ }));
    fireEvent.click(screen.getByRole("button", { name: /Alle/ }));
    expect(picked).toEqual(["hiring_signal", "all"]);
  });

  it("marks the selected pill with the active style", () => {
    render(<PlayPills plays={PLAYS} value="hiring_signal" onChange={() => {}} countFor={countFor} />);
    const active = screen.getByRole("button", { name: /Hiring/ });
    const inactive = screen.getByRole("button", { name: /Lead flow/ });
    expect(active.className).toContain("bg-[var(--sand)]/60");
    expect(inactive.className).not.toContain("bg-[var(--sand)]/60");
  });
});
