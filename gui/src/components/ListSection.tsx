import type { ReactNode } from "react";

export function ListSection({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="gc-list-section">
      <header className="gc-list-section-header">
        <span>
          {title} <span className="gc-count">({count})</span>
        </span>
        {actions && <span className="gc-list-section-actions">{actions}</span>}
      </header>
      <ul className="gc-session-list">{children}</ul>
    </section>
  );
}
