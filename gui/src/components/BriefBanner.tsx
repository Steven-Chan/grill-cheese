import { useState } from "react";

interface Props {
  brief: string;
}

export function BriefBanner({ brief }: Props) {
  const [open, setOpen] = useState(false);
  if (!brief) return null;
  return (
    <div className={`gc-brief${open ? " open" : ""}`}>
      <button
        type="button"
        className="gc-brief-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾ brief" : "▸ brief"}
      </button>
      {open && <div className="gc-brief-body">{brief}</div>}
    </div>
  );
}
