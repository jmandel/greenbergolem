// Tiny (?) icon that opens a definition popover. The popover floats
// ABOVE the icon by default but flips below if there isn't enough room
// above (detected on open).

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function Help({
  term,
  children,
  source,
}: {
  term: string;
  children: React.ReactNode;
  source?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"top" | "bottom">("top");
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Decide placement on open. If the tooltip as-drawn-above would
  // overflow the viewport top (or the scroll container top), flip
  // below where there's always room.
  useLayoutEffect(() => {
    if (!open || !wrapperRef.current || !tooltipRef.current) return;
    const btnRect = wrapperRef.current.getBoundingClientRect();
    const tipH = tooltipRef.current.offsetHeight + 12;
    const spaceAbove = btnRect.top;
    setPlacement(spaceAbove < tipH ? "bottom" : "top");
  }, [open]);

  return (
    <span ref={wrapperRef} className="help">
      <button
        type="button"
        className="help-btn"
        aria-label={`What is ${term}?`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        ?
      </button>
      {open && (
        <span
          ref={tooltipRef}
          role="tooltip"
          className={`help-tooltip place-${placement}`}
        >
          <strong className="help-term">{term}</strong>
          <span className="help-body">{children}</span>
          {source && <em className="help-source">{source}</em>}
        </span>
      )}
    </span>
  );
}
