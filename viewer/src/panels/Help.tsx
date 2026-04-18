// Tiny (?) icon that opens a definition popover. Used throughout the
// sidebar for domain terms (authority, lens effect, invention types,
// evidence groups, …) so readers can learn the vocabulary inline
// without leaving the figure.

import { useEffect, useRef, useState } from "react";

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
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

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
        <span role="tooltip" className="help-tooltip">
          <strong className="help-term">{term}</strong>
          <span className="help-body">{children}</span>
          {source && <em className="help-source">{source}</em>}
        </span>
      )}
    </span>
  );
}
