"use client";

import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/frontend/components/ui/tabs";
import { cn } from "@/shared/utils";
import { formatNumber, formatPercent, formatSom } from "@/shared/format";
import type { RnpDay, RnpProduct } from "@/shared/types";
import { Download } from "lucide-react";

// ─── Вспомогательные ────────────────────────────────────────────────────────

function planCompletionClass(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct >= 100) return "text-emerald-400";
  if (pct >= 70) return "text-amber-400";
  return "text-red-400";
}

function pct(fact: number, plan: number): number | null {
  if (!plan) return null;
  return Math.round((fact / plan) * 100);
}

// ─── Карточка экономики товара ──────────────────────────────────────────────

function EconomicsCard({ product }: { product: RnpProduct }) {
  const e = product.economics;
  const metrics: { label: string; value: string }[] = [
    { label: "Себестоимость", value: formatSom(e.costPrice) },
    { label: "Цена", value: formatSom(e.priceRub) },
    { label: "Логистика", value: formatSom(e.logistics) },
    { label: "Прибыль (мес)", value: formatSom(e.profitRub) },
    { label: "Маржа", value: formatPercent(e.marginPct) },
    { label: "Рентабельность", value: formatPercent(e.profitabilityPct) },
    { label: "ДРР", value: formatPercent(e.drrPct) },
    { label: "CTR", value: formatPercent(e.ctrPct) },
    { label: "Показы", value: formatNumber(e.views) },
    { label: "Выкуп", value: formatPercent(e.buyoutPct) },
    { label: "CRO", value: formatPercent(e.croPct, 2) },
    { label: "СПП", value: formatPercent(e.sppPct) },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/40 to-fuchsia-600/40 text-lg font-semibold">
            {product.tabLabel[0].toUpperCase()}
          </div>
          <div>
            <CardTitle className="text-sm">{product.title}</CardTitle>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span>арт. {product.nmId}</span>
              <Badge variant="secondary" className="text-[10px]">
                {product.status}
              </Badge>
              <span>отв.: {product.responsible}</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-4 xl:grid-cols-6">
          {metrics.map((m) => (
            <div key={m.label}>
              <div className="text-[11px] text-muted-foreground">{m.label}</div>
              <div className="text-sm font-medium tabular-nums">{m.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Матрица размеров ───────────────────────────────────────────────────────

function SizeMatrix({ product }: { product: RnpProduct }) {
  const { sizes, rows } = product.sizeMatrix;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Матрица размеров</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-normal" />
              {sizes.map((s) => (
                <th key={s} className="px-2 py-1.5 text-right font-normal">
                  {s}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium">Σ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-border/60">
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {row.label}
                </td>
                {row.values.map((v, i) => (
                  <td key={i} className="px-2 py-1.5 text-right tabular-nums">
                    {v}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                  {row.values.reduce((s, v) => s + v, 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── Недельная сетка план/факт ──────────────────────────────────────────────

type RowDef = {
  label: string;
  group?: string;
  render: (d: RnpDay) => React.ReactNode;
};

function WeekGrid({
  product,
  canEdit,
}: {
  product: RnpProduct;
  canEdit: boolean;
}) {
  const [plans, setPlans] = useState<Record<string, number>>({});

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const isFuture = (d: RnpDay) => d.date > todayIso;

  const dayPlan = (d: RnpDay) => plans[d.date] ?? d.ordersPlan;

  const savePlan = (d: RnpDay, value: number) => {
    setPlans((p) => ({ ...p, [d.date]: value }));
    toast.success(
      `План заказов на ${d.label} сохранён: ${value} шт (демо — запись в rnp_plans после подключения БД)`,
    );
  };

  const rows: RowDef[] = useMemo(
    () => [
      {
        label: "ЗАКАЗЫ (шт)",
        group: "orders",
        render: (d) => <span className="font-medium">{d.ordersFact}</span>,
      },
      {
        label: "План заказ",
        render: (d) =>
          canEdit ? (
            <input
              type="number"
              min={0}
              defaultValue={dayPlan(d)}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v) && v !== dayPlan(d)) savePlan(d, v);
              }}
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5 text-right text-xs tabular-nums focus:border-ring focus:outline-none"
            />
          ) : (
            dayPlan(d)
          ),
      },
      {
        label: "Выпол. плана ЗАКАЗ",
        render: (d) => {
          const p = isFuture(d) ? null : pct(d.ordersFact, dayPlan(d));
          return (
            <span className={planCompletionClass(p)}>
              {p === null ? "—" : `${p}%`}
            </span>
          );
        },
      },
      { label: "СПП %", render: (d) => (d.sppPct ? formatPercent(d.sppPct) : "—") },
      {
        label: "Продажи (шт)",
        group: "sales",
        render: (d) => <span className="font-medium">{d.salesFact}</span>,
      },
      { label: "План продаж", render: (d) => d.salesPlan },
      {
        label: "Выпол. плана ПРОДАЖ",
        render: (d) => {
          const p = isFuture(d) ? null : pct(d.salesFact, d.salesPlan);
          return (
            <span className={planCompletionClass(p)}>
              {p === null ? "—" : `${p}%`}
            </span>
          );
        },
      },
      { label: "Ср. чек", render: (d) => (d.avgCheck ? formatSom(d.avgCheck) : "—") },
      { label: "Раздачи", render: (d) => d.giveaways },
      {
        label: "Сумма заказов",
        group: "money",
        render: (d) => (d.ordersSumRub ? formatSom(d.ordersSumRub) : "—"),
      },
      {
        label: "Сумма продаж",
        render: (d) => (d.salesSumRub ? formatSom(d.salesSumRub) : "—"),
      },
      {
        label: "Показы",
        group: "funnel",
        render: (d) => (d.views ? formatNumber(d.views) : "—"),
      },
      { label: "Клики", render: (d) => (d.clicks ? formatNumber(d.clicks) : "—") },
      { label: "CTR %", render: (d) => (d.ctrPct ? formatPercent(d.ctrPct) : "—") },
      { label: "Корзина (шт)", render: (d) => d.cartQty || "—" },
      { label: "Корзина %", render: (d) => (d.cartPct ? formatPercent(d.cartPct) : "—") },
      { label: "Заказы %", render: (d) => (d.orderPct ? formatPercent(d.orderPct) : "—") },
      { label: "CRO %", render: (d) => (d.croPct ? formatPercent(d.croPct, 2) : "—") },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, plans],
  );

  const GROUP_TITLES: Record<string, string> = {
    orders: "ЗАКАЗЫ",
    sales: "ПРОДАЖИ",
    money: "СУММА ПРОДАЖ, СОМ",
    funnel: "ПОКАЗАТЕЛИ ВОРОНКИ",
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-sm">
          Текущая неделя · план / факт
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast.info("Экспорт в Excel будет доступен в Фазе 5 (exceljs)")
          }
        >
          <Download className="size-3.5" />
          Excel
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 w-44 bg-card py-1.5 pr-3 text-left font-normal">
                Показатель
              </th>
              {product.days.map((d) => (
                <th key={d.date} className="px-2 py-1.5 text-right font-normal">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.label}>
                {row.group && (
                  <tr className="border-t border-border">
                    <td
                      colSpan={product.days.length + 1}
                      className="sticky left-0 bg-card pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground"
                    >
                      {GROUP_TITLES[row.group]}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-border/40">
                  <td className="sticky left-0 bg-card py-1.5 pr-3 text-muted-foreground">
                    {row.label}
                  </td>
                  {product.days.map((d) => (
                    <td key={d.date} className="px-2 py-1.5 text-right tabular-nums">
                      {row.render(d)}
                    </td>
                  ))}
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── Сводка по неделям месяца ───────────────────────────────────────────────

function WeeksSummary({ product }: { product: RnpProduct }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Недели месяца</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-normal">Неделя</th>
              <th className="px-2 py-1.5 text-right font-normal">Заказы факт/план</th>
              <th className="px-2 py-1.5 text-right font-normal">Выпол. ЗАКАЗ</th>
              <th className="px-2 py-1.5 text-right font-normal">Продажи факт/план</th>
              <th className="px-2 py-1.5 text-right font-normal">Выпол. ПРОДАЖ</th>
              <th className="px-2 py-1.5 text-right font-normal">Сумма заказов</th>
              <th className="px-2 py-1.5 text-right font-normal">Сумма продаж</th>
            </tr>
          </thead>
          <tbody>
            {product.weeks.map((w) => {
              const isTotal = w.label === "ИТОГ";
              // неделя ещё не началась — не подсвечивать 0% как провал
              const notStarted = !isTotal && w.ordersFact === 0 && w.salesFact === 0;
              const po = notStarted ? null : pct(w.ordersFact, w.ordersPlan);
              const ps = notStarted ? null : pct(w.salesFact, w.salesPlan);
              return (
                <tr
                  key={w.label}
                  className={cn(
                    "border-t border-border/40",
                    isTotal && "border-border font-medium",
                  )}
                >
                  <td className="py-1.5 pr-3">{w.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {w.ordersFact} / {w.ordersPlan}
                  </td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums", planCompletionClass(po))}>
                    {po === null ? "—" : `${po}%`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {w.salesFact} / {w.salesPlan}
                  </td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums", planCompletionClass(ps))}>
                    {ps === null ? "—" : `${ps}%`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatSom(w.ordersSumRub)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatSom(w.salesSumRub)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── Корневой компонент модуля ──────────────────────────────────────────────

export function RnpView({
  products,
  canEdit,
}: {
  products: RnpProduct[];
  canEdit: boolean;
}) {
  const [active, setActive] = useState(products[0]?.id ?? "");
  const product = products.find((p) => p.id === active) ?? products[0];

  if (!product) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Данных для РНП пока нет. Добавьте товары на странице «Товары» — план/факт
          появится после первых заказов или синхронизации с WB.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Tabs value={active} onValueChange={(v) => setActive(String(v))}>
        <TabsList className="h-auto flex-wrap">
          {products.map((p) => (
            <TabsTrigger key={p.id} value={p.id} className="text-xs">
              {p.tabLabel}
              <Badge variant="secondary" className="ml-1.5 px-1 text-[9px]">
                {p.weeks[p.weeks.length - 1].ordersFact}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <EconomicsCard product={product} />
      <div className="grid gap-3 xl:grid-cols-2">
        <SizeMatrix product={product} />
        <WeeksSummary product={product} />
      </div>
      <WeekGrid product={product} canEdit={canEdit} />
    </div>
  );
}
