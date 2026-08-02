"use client";

import { useState } from "react";
import { Trophy, AlertTriangle } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import { cn } from "@/shared/utils";
import type { DutyGrade, DutyStats } from "@/shared/types";

// Цвета дисциплины: зелёный — молодец, жёлтый — средне, красный — плохо.
// Пороги задаёт data-слой (score ≥80 / 50–79 / <50), здесь только отображение.
const GRADE_META: Record<
  DutyGrade,
  { label: string; badge: string; bar: string; score: string }
> = {
  good: {
    label: "Отлично",
    badge: "border-emerald-500/50 text-emerald-400",
    bar: "bg-emerald-500",
    score: "text-emerald-400",
  },
  ok: {
    label: "Средне",
    badge: "border-amber-500/50 text-amber-400",
    bar: "bg-amber-500",
    score: "text-amber-400",
  },
  bad: {
    label: "Плохо",
    badge: "border-red-500/50 text-red-400",
    bar: "bg-red-500",
    score: "text-red-400",
  },
};

function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-all", className)}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

export function DutyStatsSection({
  stats,
  currentUserId,
  seesTeam,
}: {
  stats: DutyStats;
  currentUserId: string;
  seesTeam: boolean;
}) {
  const [days, setDays] = useState<7 | 30>(7);
  const period = days === 7 ? stats.d7 : stats.d30;
  const list = seesTeam
    ? period.employees
    : period.employees.filter((e) => e.assigneeId === currentUserId);

  // Нечего показывать — не рисуем секцию вовсе (у специалиста: только его строки)
  const anyRows = seesTeam
    ? stats.d7.employees.length > 0 || stats.d30.employees.length > 0
    : [...stats.d7.employees, ...stats.d30.employees].some(
        (e) => e.assigneeId === currentUserId,
      );
  if (!anyRows) return null;

  return (
    <div className="space-y-2 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">
            {seesTeam ? "Статистика команды" : "Моя статистика"}
          </h2>
          {seesTeam && period.employees.length > 0 && (
            <p className="text-xs text-muted-foreground/70">
              Команда за {days} дн.: выполнение {period.teamCompletionPct}% · вовремя{" "}
              {period.teamOnTimePct}%
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {([7, 30] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? "default" : "outline"}
              onClick={() => setDays(d)}
            >
              {d} дней
            </Button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-xs text-muted-foreground">
            За выбранный период данных пока нет
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((e, idx) => {
            const meta = GRADE_META[e.grade];
            return (
              <Card key={e.assigneeId} className="py-4">
                <CardContent className="space-y-3 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        {seesTeam && idx === 0 && list.length > 1 && e.grade === "good" && (
                          <Trophy className="size-3.5 shrink-0 text-amber-400" />
                        )}
                        <span className="truncate">{e.assigneeName}</span>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn("mt-1 text-[10px]", meta.badge)}
                      >
                        {meta.label}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <div className={cn("text-2xl font-semibold tabular-nums", meta.score)}>
                        {e.score}
                      </div>
                      <div className="text-[10px] text-muted-foreground">балл из 100</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div>
                      <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                        <span>Выполнение</span>
                        <span className="tabular-nums">{e.completionPct}%</span>
                      </div>
                      <Bar pct={e.completionPct} className={meta.bar} />
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                        <span>Вовремя</span>
                        <span className="tabular-nums">{e.onTimePct}%</span>
                      </div>
                      <Bar pct={e.onTimePct} className={meta.bar} />
                    </div>
                  </div>

                  <div className="text-[11px] text-muted-foreground">
                    {e.done} из {e.total} выполнено
                    {e.missed > 0 ? ` · ${e.missed} просрочено` : " · без просрочек"}
                  </div>

                  {e.problems.length > 0 && (
                    <div className="rounded-md border border-border/60 bg-background/40 p-2">
                      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <AlertTriangle className="size-3 text-amber-400" />
                        Чаще срывается
                      </div>
                      <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground/80">
                        {e.problems.map((p) => (
                          <li key={p.title} className="truncate">
                            {p.title} —{" "}
                            {[
                              p.missed > 0 ? `просрочено ${p.missed}` : null,
                              p.late > 0 ? `с опозданием ${p.late}` : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
