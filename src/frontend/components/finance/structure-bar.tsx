"use client";

import { cn } from "@/shared/utils";

// «Куда уходит выручка» — часть-к-целому одной горизонтальной полосой.
// Почему так (dataviz): для 4–6 частей это читается точнее пирога, а между
// сегментами держим 2px зазор фоном — идентичность не зависит только от цвета
// (плюс легенда с прямыми подписями и процентами под полосой).

export type StructureSegment = {
  label: string;
  value: number; // абсолютное значение
  color: string;
  hint?: string;
};

export function StructureBar({
  segments,
  total,
  formatValue,
  className,
}: {
  segments: StructureSegment[];
  total: number; // база = 100% (обычно выручка)
  formatValue: (v: number) => string;
  className?: string;
}) {
  const positive = segments.filter((s) => s.value > 0);
  const base = total > 0 ? total : positive.reduce((t, s) => t + s.value, 0);
  if (base <= 0) return null;

  const pct = (v: number) => (v / base) * 100;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md">
        {positive.map((s) => (
          <div
            key={s.label}
            className="h-full min-w-[2px] first:rounded-l-md last:rounded-r-md"
            style={{ width: `${pct(s.value)}%`, backgroundColor: s.color }}
            title={`${s.label}: ${formatValue(s.value)} (${pct(s.value).toFixed(1)}%)`}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {positive.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            <span className="text-xs text-muted-foreground">
              {s.label}
              {s.hint ? ` · ${s.hint}` : ""}
            </span>
            <span className="text-xs font-medium tabular-nums">
              {formatValue(s.value)}
              <span className="ml-1.5 text-muted-foreground">{Math.round(pct(s.value))}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
