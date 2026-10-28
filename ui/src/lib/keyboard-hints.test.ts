/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadOnTouchOnlyDevice() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("any-pointer: coarse"),
    addEventListener() {},
  }));
  const hints = await import("./keyboard-hints.ts");
  hints.installKeyboardHints();
  return hints;
}

it("hides hints on touch-only devices until a hardware-only key is pressed", async () => {
  const { keyboardHints } = await loadOnTouchOnlyDevice();
  const notify = vi.fn();
  keyboardHints.subscribe(notify);
  const field = document.body.appendChild(document.createElement("textarea"));

  // On-screen keyboards type into fields, including Return and Tab, or compose.
  for (const init of [
    { key: "a" },
    { key: "Enter" },
    { key: "Tab" },
    { key: "Process", keyCode: 229 },
  ]) {
    field.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
  }
  expect(keyboardHints.visible()).toBe(false);

  field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(keyboardHints.visible()).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("treats a key outside text fields or a modifier chord as a hardware keyboard", async () => {
  const { isHardwareKeyboardEvent } = await loadOnTouchOnlyDevice();
  const field = document.body.appendChild(document.createElement("input"));
  const pressed = (target: EventTarget, init: KeyboardEventInit) => {
    let result = false;
    target.addEventListener("keydown", (event) => (result = isHardwareKeyboardEvent(event)), {
      once: true,
    });
    target.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
    return result;
  };
  expect(pressed(document.body, { key: "Tab" })).toBe(true);
  expect(pressed(field, { key: "k", metaKey: true })).toBe(true);
  expect(pressed(field, { key: "k" })).toBe(false);
});

it("keeps hints on pointer devices", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  const { keyboardHints } = await import("./keyboard-hints.ts");
  expect(keyboardHints.visible()).toBe(true);
});
