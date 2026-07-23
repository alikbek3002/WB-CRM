"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Target } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Input } from "@/frontend/components/ui/input";
import { Label } from "@/frontend/components/ui/label";
import {
  AXIS_TICK,
  GRID_STROKE,
  SERIES,
  TOOLTIP_STYLE,
} from "@/frontend/components/charts/palette";
import { formatRub } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { SalesPlanView } from "@/shared/types";

const PLAN_COLOR = "rgba(144, 133, 233, 0.55)"; // фиолетовый — план
const FACT_COLOR = SERIES[0]; // синий — факт

const compactRub = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)} млн` : v >= 1_000 ? `${Math.round(v / 1_000)} тыс` : String(v);

type ChartPoint = {
  label: string;
  date: string;
  plan: number;
  fact: number | null; // null — будущее (бар не рисуем)
};

function PlanFactTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: ChartPoint }[];
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const diff = p.fact !== null ? p.fact - p.plan : null;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="font-medium">{p.label}</div>
      <div>План: {formatRub(p.plan)}</div>
      {p.fact !== null && <div>Факт: {formatRub(p.fact)}</div>}
      {diff !== null && (
        <div style={{ color: diff >= 0 ? "#34d399" : "#f87171" }}>
          {diff >= 0 ? "+" : ""}
          {formatRub(diff)}
        </div>
      )}
    </div>
  );
}

// Диалог задания плана WB на период (сумма из кабинета WB)
function PlanDialog({
  view,
  open,
  onOpenChange,
}: {
  view: SalesPlanView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [start, setStart] = useState(view.periodStart);
  const [end, setEnd] = useState(view.periodEnd);
  const [amount, setAmount] = useState(view.amountRub ? String(view.amountRub) : "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    const sum = Number(amount.replace(/[\s,]/g, "").replace(",", "."));
    if (!Number.isFinite(sum) || sum <= 0) {
      toast.error("Укажите сумму плана в рублях");
      return;
    }
    if (!start || !end || start >= end) {
      toast.error("Проверьте даты периода");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/finance/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ periodStart: start, periodEnd: end, amountRub: sum }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success("План сохранён — график пересчитан");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось сохранить план: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>План продаж WB на период</DialogTitle>
          <DialogDescription>
            Сумма плана из кабинета WB — система разложит по дням и будет
            сравнивать с фактом продаж автоматически.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="plan-start">Начало периода</Label>
            <Input
              id="plan-start"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plan-end">Конец периода</Label>
            <Input
              id="plan-end"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="plan-amount">План на период, ₽</Label>
            <Input
              id="plan-amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Например: 650000000"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить план"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export function PlanFact({
  view,
  canPlan,
}: {
  view: SalesPlanView;
  canPlan: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  // Месяцы периода: листаем стрелками, по умолчанию — текущий (или первый)
  const months = useMemo(() => {
    const set: string[] = [];
    for (const d of view.days) {
      const m = d.date.slice(0, 7);
      if (set[set.length - 1] !== m) set.push(m);
    }
    return set;
  }, [view.days]);

  const today = new Date();
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const [monthIdx, setMonthIdx] = useState(() => {
    const i = months.indexOf(currentMonth);
    return i >= 0 ? i : 0;
  });
  const month = months[monthIdx] ?? currentMonth;

  const monthDays = useMemo(
    () => view.days.filter((d) => d.date.startsWith(month)),
    [view.days, month],
  );
  const points: ChartPoint[] = monthDays.map((d) => ({
    label: d.label.split(".")[0], // день месяца: «01», «02»…
    date: d.date,
    plan: d.planRub,
    fact: d.isFuture ? null : d.factRub,
  }));

  const monthPlan = monthDays.reduce((t, d) => t + d.planRub, 0);
  const monthFact = monthDays.reduce((t, d) => t + (d.isFuture ? 0 : d.factRub), 0);
  const [y, m] = month.split("-").map(Number);
  const monthTitle = `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;

  const periodLabel = `${view.periodStart.split("-").reverse().slice(0, 2).join(".")} — ${view.periodEnd
    .split("-")
    .reverse()
    .slice(0, 2)
    .join(".")}`;

  const kpis = [
    { label: `План на период (${periodLabel})`, value: view.hasPlan ? formatRub(view.amountRub) : "не задан", className: "" },
    { label: "Факт продаж с начала периода", value: formatRub(view.factToDateRub), className: "" },
    {
      label: "Выполнение плана на сегодня",
      value: view.hasPlan ? `${view.completionPct}%` : "—",
      className: view.hasPlan
        ? view.completionPct >= 100
          ? "text-emerald-400"
          : view.completionPct >= 80
            ? "text-amber-400"
            : "text-red-400"
        : "",
    },
    {
      label: "Нужно продавать в день",
      value: view.hasPlan ? formatRub(view.neededDailyRub) : "—",
      className: "",
      hint: view.hasPlan ? `план ${formatRub(view.dailyPlanRub)}/дн` : undefined,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className={cn("text-xl font-semibold tabular-nums", k.className)}>
                {k.value}
              </div>
              {"hint" in k && k.hint && (
                <div className="text-[11px] text-muted-foreground">{k.hint}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            План / факт продаж
            <span className="ml-2 font-normal text-muted-foreground">
              план — фиолетовый, факт — синий
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMonthIdx((i) => Math.max(0, i - 1))}
              disabled={monthIdx === 0}
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-32 text-center text-sm font-medium">{monthTitle}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMonthIdx((i) => Math.min(months.length - 1, i + 1))}
              disabled={monthIdx >= months.length - 1}
              aria-label="Следующий месяц"
            >
              <ChevronRight className="size-4" />
            </Button>
            {canPlan && (
              <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
                <Target className="size-4" />
                {view.hasPlan ? "Изменить план" : "Задать план"}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!view.hasPlan && (
            <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
              План не задан — на графике только факт. Нажмите «Задать план» и
              введите сумму плана WB на полугодие (со 2 июля).
            </p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span>
              План на {monthTitle.toLowerCase()}:{" "}
              <span className="font-medium text-foreground">{formatRub(monthPlan)}</span>
            </span>
            <span>
              Факт:{" "}
              <span
                className={cn(
                  "font-medium",
                  monthFact >= monthPlan ? "text-emerald-400" : "text-foreground",
                )}
              >
                {formatRub(monthFact)}
              </span>
            </span>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={points} barGap={1} barCategoryGap="22%">
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                interval={0}
              />
              <YAxis
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactRub}
                width={56}
              />
              <Tooltip content={<PlanFactTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              {view.hasPlan && (
                <Bar dataKey="plan" name="План" fill={PLAN_COLOR} radius={[3, 3, 0, 0]} />
              )}
              <Bar dataKey="fact" name="Факт" fill={FACT_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <PlanDialog view={view} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
