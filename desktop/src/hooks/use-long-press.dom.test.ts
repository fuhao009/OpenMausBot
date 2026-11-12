// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LONG_PRESS_MS, pressMoved, useLongPress } from "./use-long-press";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Row({ onLongPress, onClick }: { onLongPress: (point: { x: number; y: number }) => void; onClick: () => void }) {
  return createElement("button", { type: "button", onClick, ...useLongPress(onLongPress) }, "row");
}

function mount() {
  const onLongPress = vi.fn();
  const onClick = vi.fn();
  flushSync(() => root.render(createElement(Row, { onLongPress, onClick })));
  return { onLongPress, onClick, button: container.querySelector("button")! };
}

const pointer = (button: HTMLElement, type: string, init: PointerEventInit) =>
  flushSync(() => button.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, ...init })));

describe("long press", () => {
  it("opens the menu where a finger is held, and swallows the click that ends it", () => {
    const { onLongPress, onClick, button } = mount();
    pointer(button, "pointerdown", { pointerType: "touch", clientX: 40, clientY: 50 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledExactlyOnceWith({ x: 40, y: 50 });
    pointer(button, "pointerup", { pointerType: "touch" });
    flushSync(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
    flushSync(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("leaves a short tap, a scroll and a mouse alone", () => {
    const { onLongPress, onClick, button } = mount();
    pointer(button, "pointerdown", { pointerType: "touch", clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    pointer(button, "pointerup", { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(button, "pointerdown", { pointerType: "touch", clientX: 0, clientY: 0 });
    pointer(button, "pointermove", { pointerType: "touch", clientX: 0, clientY: 30 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(button, "pointerdown", { pointerType: "mouse", clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
    flushSync(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("allows a finger's small wobble", () => {
    expect(pressMoved({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(false);
    expect(pressMoved({ x: 0, y: 0 }, { x: 9, y: 0 })).toBe(true);
  });
});
