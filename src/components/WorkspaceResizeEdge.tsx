import { useEffect, useRef, useState, type RefObject } from "react";

export function WorkspaceResizeEdge({ target, side, label, storageKey, minimum, maximum }: {
  target: RefObject<HTMLElement | null>; side: "left" | "right"; label: string;
  storageKey: string; minimum: number; maximum: number;
}) {
  const [width, setWidth] = useState(minimum);
  const drag = useRef<{ id: number; x: number; width: number; latest: number } | null>(null);
  const frame = useRef(0);
  const bounds = () => {
    const root = target.current;
    let parent = root?.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
    const other = root?.parentElement ? [...root.parentElement.children].filter((node) => node !== root && node instanceof HTMLElement && (node.hasAttribute("data-sidebar") || node.hasAttribute("data-product-work-panel"))) : [];
    const occupied = other.reduce((sum, node) => sum + (node instanceof HTMLElement && getComputedStyle(node).position !== "fixed" ? node.getBoundingClientRect().width : 0), 0);
    return Math.max(minimum, Math.min(maximum, (parent?.clientWidth ?? window.innerWidth) - occupied - 420));
  };
  const apply = (value: number) => {
    const next = Math.round(Math.max(minimum, Math.min(bounds(), value)));
    target.current?.style.setProperty("--workspace-width", `${next}px`);
    return next;
  };
  const save = (value: number) => {
    setWidth(value);
    try { localStorage.setItem(storageKey, String(value)); } catch {}
  };
  useEffect(() => {
    let saved = 0;
    try { saved = Number(localStorage.getItem(storageKey)); } catch {}
    if (saved > 0 && Number.isFinite(saved)) setWidth(apply(saved));
    const resize = () => {
      const root = target.current;
      if (root?.style.getPropertyValue("--workspace-width")) setWidth(apply(root.getBoundingClientRect().width));
    };
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(() => {
      const root = target.current;
      if (root && root.getBoundingClientRect().width > bounds()) setWidth(apply(root.getBoundingClientRect().width));
    });
    if (target.current?.parentElement) observer.observe(target.current.parentElement);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); cancelAnimationFrame(frame.current); };
  }, [storageKey]);
  const finish = (cancelled: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = apply(cancelled ? active.width : active.latest);
    if (!cancelled) save(next);
  };
  return <div role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0}
    aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
    data-workspace-resize={side}
    className={`absolute inset-y-0 z-30 w-3 touch-none cursor-col-resize select-none outline-none hover:bg-accent/10 focus-visible:bg-accent/20 ${side === "left" ? "-left-1.5" : "-right-1.5"}`}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary || drag.current || !target.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      const current = target.current.getBoundingClientRect().width;
      drag.current = { id: event.pointerId, x: event.clientX, width: current, latest: current };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.id !== event.pointerId) return;
      active.latest = active.width + (event.clientX - active.x) * (side === "left" ? -1 : 1);
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (drag.current) apply(drag.current.latest); });
    }}
    onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
    onKeyDown={(event) => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const delta = (event.key === "ArrowRight" ? 16 : -16) * (side === "left" ? -1 : 1);
      save(apply((target.current?.getBoundingClientRect().width ?? minimum) + delta));
    }} />;
}
