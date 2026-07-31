"use client";

import type { ReactNode } from "react";
import { cn } from "@/shared/utils";

// Плотная лента метрик вместо крупных карточек-квадратов: цифры стоят рядом
// и читаются одним движением глаза, а не как четыре отдельных плаката.
// Контракт метрики (dataviz): подпись → значение → необязательная дельта/хинт.

export type Stat = {
  label: string;
  value: string;
  hint?: string;
  delta?: { text: string; good: boolean | null }; // null — нейтрально
  tone?: "default" | "good" | "bad" | "muted";
};

const TONE: Record<NonNullable<Stat["tone"]>, string> = {
  default: "text-foreground",
  good: "text-emerald-400",
  bad: "text-red-400",
  muted: "text-muted-foreground",
};

export function StatRow({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-border/60 bg-card px-4 py-3.5 sm:grid-cols-3 lg:grid-cols-4",
        className,
      )}
    >
      {stats.map((s) => (
        <div key={s.label} className="min-w-0">
          <div className="truncate text-[11px] tracking-wide text-muted-foreground uppercase">
            {s.label}
          </div>
          <div
            className={cn(
              "mt-0.5 truncate text-lg font-semibold",
              TONE[s.tone ?? "default"],
            )}
            title={s.value}
          >
            {s.value}
          </div>
          {s.delta && (
            <div
              className={cn(
                "text-[11px]",
                s.delta.good === null
                  ? "text-muted-foreground"
                  : s.delta.good
                    ? "text-emerald-400"
                    : "text-red-400",
              )}
            >
              {s.delta.text}
            </div>
          )}
          {s.hint && (
            <div className="truncate text-[11px] text-muted-foreground">{s.hint}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// Главное число раздела — ровно одно на экран (dataviz: hero figure).
// Проще всего читается, когда рядом стоит его «расшифровка» одной строкой.
export function HeroStat({
  label,
  value,
  tone = "default",
  caption,
  aside,
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad";
  caption?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-border/60 bg-card px-4 py-4">
      <div className="min-w-0">
        <div className="text-[11px] tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        <div
          className={cn(
            "text-4xl leading-tight font-semibold sm:text-5xl",
            tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "",
          )}
        >
          {value}
        </div>
        {caption && <div className="mt-1 text-xs text-muted-foreground">{caption}</div>}
      </div>
      {aside}
    </div>
  );
}
