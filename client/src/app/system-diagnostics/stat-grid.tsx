import type { ReactNode } from "react";

export function Stat({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

export function StatGrid({
  showExplanations,
  cols = 4,
  children,
}: {
  showExplanations: boolean;
  cols?: 4 | 5;
  children: ReactNode;
}) {
  const gridClass = showExplanations
    ? "grid-cols-1 md:grid-cols-2"
    : cols === 5
      ? "grid-cols-2 md:grid-cols-5"
      : "grid-cols-2 md:grid-cols-4";
  return (
    <dl className={`grid gap-x-6 gap-y-3 ${gridClass}`}>{children}</dl>
  );
}
