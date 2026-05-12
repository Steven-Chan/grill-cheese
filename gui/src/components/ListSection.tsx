import type { ReactNode } from "react";

export function ListSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="gc-list-section">
      <header className="gc-list-section-header">
        {title} <span className="gc-count">({count})</span>
      </header>
      <ul className="gc-session-list">{children}</ul>
    </section>
  );
}
