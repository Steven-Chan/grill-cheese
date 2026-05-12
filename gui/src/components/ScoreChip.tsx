// Small badge showing session-level pick rate. Shared by SessionListPage,
// SessionDetailPage header (when ended), and PerformancePage rows. Renders
// "—" when score is null/undefined (pre-feature session OR no scored
// decisions). See CONTEXT.md "Recommendation score".

interface ScoreChipProps {
  score: number | null | undefined;
  count?: number | null | undefined;
}

export function ScoreChip({ score, count }: ScoreChipProps) {
  if (score == null) {
    return (
      <span className="gc-chip gc-chip-score gc-chip-score-empty" title="no scored decisions">
        — pick rate
      </span>
    );
  }
  const pct = Math.round(score * 100);
  const tone = score >= 0.7 ? "high" : score >= 0.4 ? "mid" : "low";
  const countLabel = count != null && count > 0 ? ` (${count})` : "";
  return (
    <span
      className={`gc-chip gc-chip-score gc-chip-score-${tone}`}
      title={`Agent recommendation pick rate${count != null ? ` over ${count} decisions` : ""}`}
    >
      {pct}% pick rate{countLabel}
    </span>
  );
}
