/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { isMobileBrowserPlatform, keepMobileReturnNative } from "./browser-platform.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  { userAgent: "iPhone", platform: "iPhone", touch: 5, mobile: true },
  { userAgent: "iPad", platform: "iPad", touch: 5, mobile: true },
  { userAgent: "Macintosh", platform: "MacIntel", touch: 5, mobile: true },
  { userAgent: "Android", platform: "Linux armv8l", touch: 5, mobile: true },
  { userAgent: "Windows", platform: "Win32", touch: 10, mobile: false },
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0",
    platform: "Linux x86_64",
    touch: 10,
    mobile: false,
  },
  { userAgent: "Macintosh", platform: "MacIntel", touch: 0, mobile: false },
])(
  "classifies $userAgent/$platform with $touch touch points",
  ({ userAgent, platform, touch, mobile }) => {
    vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints: touch });
    vi.stubGlobal("innerWidth", 390);
    expect(isMobileBrowserPlatform()).toBe(mobile);
  },
);

it("keeps mobile Return native but lets hardware ⌘/Ctrl+Return reach shortcuts", () => {
  vi.stubGlobal("navigator", { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 });
  expect(keepMobileReturnNative(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
  expect(
    keepMobileReturnNative(new KeyboardEvent("keydown", { key: "Enter", metaKey: true })),
  ).toBe(false);
  expect(
    keepMobileReturnNative(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true })),
  ).toBe(false);
});
