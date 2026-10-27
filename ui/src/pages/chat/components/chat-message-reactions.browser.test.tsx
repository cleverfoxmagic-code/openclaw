import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type { TranscriptLayoutProps } from "./chat-transcript-layout.ts";
import { createTranscriptMessageElements } from "./chat-transcript-message-elements.ts";
import "../../../styles/chat/grouped.css";
import "../../../styles/chat/layout.css";

afterEach(cleanupSolid);

it("keeps the reaction picker beside its message after a virtualized transcript scroll", async () => {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1000, 800);
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText =
    "position:relative;height:500px;width:800px;overflow:auto;margin:80px 24px";
  const rows = Array.from({ length: 40 }, (_, index) => {
    const content = document.createElement("div");
    content.style.cssText = "height:80px;box-sizing:border-box;padding:8px 24px";
    content.textContent = `Synthetic row ${index + 1}`;
    return { kind: "content" as const, key: `row:${index}`, content };
  });
  const pickerHost = rows[8]!.content.appendChild(document.createElement("div"));
  const onSelect = vi.fn();
  const picker = mountSolid(
    () => (
      <MessageReactionPicker activeEmoji={new Set()} placement="bottom-start" onSelect={onSelect} />
    ),
    { container: pickerHost },
  );
  const renderer = new ChatTranscriptRenderer();
  const layout = new TranscriptLayoutOwner(() => {});
  layout.rows = rows;
  const messageElements = createTranscriptMessageElements(() => undefined);
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length,
    getScrollElement: () => viewport,
    estimateSize: () => 80,
    getItemKey: (index) => rows[index]!.key,
    scrollToFn: elementScroll,
    observeElementOffset,
    observeElementRect,
    initialRect: { width: 800, height: 500 },
    initialOffset: 400,
    overscan: 1,
    onChange: () => paint(),
  });
  const props: TranscriptLayoutProps = {
    rows,
    virtualizer,
    layout,
    messageElements,
    getContent: (index) => rows[index]!.content,
    header: null,
    overlay: null,
    headerHeight: 0,
    presented: true,
    scrollElementRef() {},
    captureInteractionResize() {},
    measureRowRefFor: () => () => {},
    measureRows: false,
    initialPositionPending: () => false,
    onCommit() {},
  };
  function paint() {
    const element = renderer.render({ ...props });
    if (element.parentElement !== viewport) {
      viewport.append(element);
    }
    renderer.connect();
  }
  const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = virtualizer;
  const releaseVirtualizer = mountVirtualizer();
  try {
    paint();
    updateVirtualizer();
    const firstIndex = () =>
      Number(viewport.querySelector(".chat-virtual-row")?.getAttribute("data-index"));
    await expect.poll(firstIndex).toBeGreaterThan(0);
    const trigger = picker.getByRole("button", { name: "Add reaction" });
    const openPicker = async () => {
      await userEvent.click(trigger);
      const popup = picker.container.querySelector<HTMLElement>(".chat-reaction-picker")!;
      await expect.poll(() => popup.dataset.phase).toBe("open");
      await expect
        .poll(() =>
          Math.abs(popup.getBoundingClientRect().top - trigger.getBoundingClientRect().bottom - 6),
        )
        .toBeLessThan(1);
    };
    await openPicker();
    await userEvent.click(picker.getByRole("button", { name: "👍" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("👍", false);
    const beforeScroll = firstIndex();
    viewport.scrollTop += 80;
    await expect.poll(firstIndex).toBeGreaterThan(beforeScroll);
    await openPicker();
  } finally {
    releaseVirtualizer();
    renderer.dispose();
    layout.disconnect();
    messageElements.dispose();
    picker.unmount();
    viewport.remove();
    await page.viewport(previousViewport.width, previousViewport.height);
  }
});

it("reveals the footer reaction trigger at the same opacity as its sibling actions", async () => {
  const view = mountSolid(() => (
    <div class="chat-group user" style={{ margin: "80px", width: "320px" }}>
      <div class="chat-group-footer-actions">
        <button class="chat-copy-btn" type="button" aria-label="Copy" />
        <MessageReactionPicker
          class="chat-reaction-action"
          activeEmoji={new Set()}
          placement="bottom-start"
          compact={false}
        />
      </div>
    </div>
  ));
  const copy = view.getByRole("button", { name: "Copy" });
  const picker = view.container.querySelector("openclaw-message-reaction-picker")!;
  const opacity = (element: Element) => getComputedStyle(element).opacity;
  await userEvent.hover(view.container.querySelector(".chat-group")!);
  await expect.poll(() => opacity(copy)).toBe("0.6");
  expect(opacity(picker)).toBe("0.6");
  await userEvent.hover(view.getByRole("button", { name: "Add reaction" }));
  await expect.poll(() => opacity(picker)).toBe("1");
});

it("keeps the hover-only picker usable when the pointer enters its native popup", async () => {
  const onSelect = vi.fn();
  const view = mountSolid(() => (
    <div class="chat-group" style={{ margin: "80px", width: "320px" }}>
      <MessageReactionPicker
        activeEmoji={new Set(["👍"])}
        placement="bottom-start"
        compact
        onSelect={onSelect}
      />
    </div>
  ));
  view.container
    .querySelector("openclaw-message-reaction-picker")!
    .classList.add("chat-reaction-chip--add");
  const trigger = view.getByRole("button", { name: "Add reaction" });
  await userEvent.hover(view.container.querySelector(".chat-group")!);
  await userEvent.click(trigger);
  const popup = view.container.querySelector<HTMLElement>(".chat-reaction-picker")!;
  await expect.poll(() => popup.dataset.phase).toBe("open");
  expect(document.activeElement).toBe(view.getByRole("button", { name: "👍" }));
  await userEvent.click(view.getByRole("button", { name: "More…" }));
  await expect.poll(() => view.queryByRole("searchbox", { name: "Search emoji…" })).not.toBeNull();
  const input = view.getByRole("searchbox", { name: "Search emoji…" });
  await expect.poll(() => document.activeElement).toBe(input);
  const closingAnimation = popup.animate({ opacity: [1, 0] }, { duration: 200 });
  closingAnimation.pause();
  await userEvent.fill(input, "🦞");
  expect(onSelect).toHaveBeenCalledWith("🦞", false);
  await expect.poll(() => popup.dataset.phase).toBe("closing");
  expect(popup.classList.contains("custom")).toBe(true);
  expect(input).toHaveProperty("value", "🦞");
  closingAnimation.finish();
  await expect.poll(() => popup.dataset.phase).toBe("hidden");
  expect(document.activeElement).toBe(trigger);
  await userEvent.click(trigger);
  await expect.poll(() => popup.dataset.phase).toBe("open");
  expect(popup.classList.contains("custom")).toBe(false);
});
