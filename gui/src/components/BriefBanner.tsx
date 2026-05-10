import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { useStore } from "../store";

export function BriefBanner() {
  const sid = useStore((s) => s.activeSessionId);
  const brief = useStore((s) => s.brief);
  const sessions = useStore((s) => s.sessions);
  const [expanded, setExpanded] = useState(false);

  if (!sid || !brief) return null;

  const meta = sessions.find((s) => s.id === sid);
  const project = meta?.project;

  // single-line teaser comes from the brief itself; CSS ellipsis trims it
  const teaser = brief.replace(/\s+/g, " ").trim();

  return (
    <section
      className="gc-brief-banner"
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        className="gc-brief-strip"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="gc-brief-teaser">{teaser}</span>
        <svg
          className="gc-brief-chevron"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          aria-hidden
        >
          <path
            d="M6 9 L12 15 L18 9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="gc-brief-body">
        <div className="gc-brief-body-inner">
          {project && (
            <span className="gc-brief-project-chip">Project: {project}</span>
          )}
          <ReactMarkdown>{brief}</ReactMarkdown>
        </div>
      </div>
    </section>
  );
}
