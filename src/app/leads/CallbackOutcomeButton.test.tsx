import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CallbackOutcomeButton, toDatetimeLocal } from "./CallbackOutcomeButton";

afterEach(cleanup);

const TONE = { dot: "dot", text: "text", surface: "surface" };
const fmt = (iso: string) => `kl-${iso}`;

function setup(props: Partial<Parameters<typeof CallbackOutcomeButton>[0]> = {}) {
  const onPick = vi.fn();
  const onClear = vi.fn();
  render(
    <CallbackOutcomeButton
      selected={false}
      callbackAt={null}
      formatTime={fmt}
      tone={TONE}
      onPick={onPick}
      onClear={onClear}
      {...props}
    />,
  );
  return { onPick, onClear };
}

describe("CallbackOutcomeButton", () => {
  it("opens the picker without writing anything", () => {
    const { onPick, onClear } = setup();
    fireEvent.click(screen.getByText("Ring tilbage"));
    expect(screen.getByText("Ring tilbage — vælg tidspunkt")).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("re-picking an existing aftale does NOT clear it before a new time is confirmed", () => {
    // Regression: tapping the selected button used to fire onClear() to force
    // the picker open, nulling outcome + next_action_at — the lead changed
    // list mid-pick and the row (with the open picker) unmounted.
    const { onPick, onClear } = setup({
      selected: true,
      callbackAt: "2026-06-15T10:00:00.000Z",
    });
    fireEvent.click(screen.getByText("Ring tilbage"));
    expect(screen.getByText("Ring tilbage — vælg tidspunkt")).toBeTruthy();
    expect(onClear).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Afbryd is lossless — closes the picker with no writes", () => {
    const { onPick, onClear } = setup({
      selected: true,
      callbackAt: "2026-06-15T10:00:00.000Z",
    });
    fireEvent.click(screen.getByText("Ring tilbage"));
    fireEvent.click(screen.getByText("Afbryd"));
    expect(onPick).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    // Back to the selected summary with the original time intact.
    expect(screen.getByText(fmt("2026-06-15T10:00:00.000Z"))).toBeTruthy();
  });

  it("OK commits the picked time via onPick", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getByText("Ring tilbage"));
    const input = document.querySelector('input[type="datetime-local"]')!;
    fireEvent.change(input, { target: { value: "2026-06-15T10:30" } });
    fireEvent.click(screen.getByText("OK"));
    expect(onPick).toHaveBeenCalledWith(new Date("2026-06-15T10:30").toISOString());
  });

  it("removing the aftale is an explicit action, only offered when one exists", () => {
    const { onClear } = setup({
      selected: true,
      callbackAt: "2026-06-15T10:00:00.000Z",
    });
    fireEvent.click(screen.getByText("Ring tilbage"));
    fireEvent.click(screen.getByText("Fjern aftalen"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers no Fjern action when nothing is scheduled", () => {
    setup();
    fireEvent.click(screen.getByText("Ring tilbage"));
    expect(screen.queryByText("Fjern aftalen")).toBeNull();
  });

  it("prefills the picker with the existing time", () => {
    setup({ selected: true, callbackAt: "2026-06-15T10:00:00.000Z" });
    fireEvent.click(screen.getByText("Ring tilbage"));
    const input = document.querySelector(
      'input[type="datetime-local"]',
    ) as HTMLInputElement;
    expect(input.value).toBe(toDatetimeLocal("2026-06-15T10:00:00.000Z"));
  });
});
