import { useEffect, useRef, type PointerEvent } from "react";

export const LONG_PRESS_MS = 500;
const SLOP_PX = 8;

export function pressMoved(start: { x: number; y: number }, now: { x: number; y: number }): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > SLOP_PX;
}

/** Touch and pen hold a row to open its menu, the way a mouse right-clicks it. A press that becomes a scroll or a drag
 * opens nothing, and the click that ends a long press is swallowed so the row does not also open. */
export function useLongPress(onLongPress: (point: { x: number; y: number }) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      fired.current = false;
      if (event.pointerType === "mouse" || event.button !== 0) return;
      const point = { x: event.clientX, y: event.clientY };
      cancel();
      start.current = point;
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        callback.current(point);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (start.current && pressMoved(start.current, { x: event.clientX, y: event.clientY })) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
