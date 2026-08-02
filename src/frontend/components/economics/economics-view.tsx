"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ImageOff } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Card, CardContent } from "@/frontend/components/ui/card";
import { formatNumber, formatRub } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { UnitEconRow, UnitEconView } from "@/shared/types";

type SortKey =
  | "saleQty"
  | "revenueRub"
  | "commissionRub"
  | "logisticsRub"
  | "storageRub"
  | "advertRub"
  | "cogsRub"
  | "profitRub"
  | "marginPct"
  | "roiPct";

const PERIODS = [
  { days: 7, label: "7 дней" },
  { days: 30, label: "30 дней" },
  { days: 90, label: "90 дней" },
];

function profitClass(v: number): string {
  if (v > 0) return "text-emerald-400";
  if (v < 0) return "text-red-400";
  return "text-muted-foreground";
}

// «прочее» = приёмка + штрафы + прочие удержания (отдельные колонки не влезают)
function otherFees(r: UnitEconRow): number {
  return r.acceptanceRub + r.penaltyRub + r.deductionRub;
}

export function EconomicsView({ view }: { view: UnitEconView }) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({
    key: "profitRub",
    asc: false,
  });

  const rows = useMemo(() => {
    const list = [...view.rows];
    list.sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      return sort.asc ? va - vb : vb - va;
    });
    return list;
  }, [view.rows, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: false }));
  }

  const t = view.totals;
  const kpis = [
    { label: "Выручка", value: formatRub(t.revenueRub) },
    { label: "Удержания WB", value: formatRub(t.wbFeesRub) },
    { label: "Реклама", value: formatRub(t.advertRub) },
    { label: "Себестоимость", value: formatRub(t.cogsRub) },
    {
      label: "Прибыль",
      value: formatRub(t.profitRub),
      sub: `маржа ${t.marginPct}%`,
      cls: profitClass(t.profitRub),
    },
  ];

  const Th = ({
    label,
    k,
    className,
  }: {
    label: string;
    k: SortKey;
    className?: string;
  }) => (
    <th
      className={cn(
        "cursor-pointer select-none whitespace-nowrap px-2 py-2 text-right font-normal transition hover:text-foreground",
        sort.key === k && "text-foreground",
        className,
      )}
      onClick={() => toggleSort(k)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {sort.key === k &&
          (sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </span>
    </th>
  );

  const Row = ({ r, muted }: { r: UnitEconRow; muted?: boolean }) => (
    <tr
      className={cn(
        "border-b border-border/40 last:border-0",
        muted && "bg-muted/20 text-muted-foreground",
      )}
    >
      <td className="max-w-64 px-4 py-2">
        <div className="flex items-center gap-2">
          {r.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={r.photoUrl}
              alt=""
              loading="lazy"
              className="h-10 w-7 shrink-0 rounded border border-border/60 object-cover"
            />
          ) : (
            <span className="flex h-10 w-7 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/40 text-muted-foreground">
              <ImageOff className="size-3.5" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm">{r.title}</span>
            <span className="block text-[11px] text-muted-foreground">
              {r.nmId > 0 ? `арт. ${r.nmId}` : "медийная реклама, хранение и удержания без привязки к товару"}
            </span>
          </span>
        </div>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{formatNumber(r.saleQty)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{formatRub(r.revenueRub)}</td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {formatRub(r.commissionRub + r.acquiringRub)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {formatRub(r.logisticsRub)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {formatRub(r.storageRub)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {otherFees(r) !== 0 ? formatRub(otherFees(r)) : "—"}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {r.advertRub !== 0 ? (
          <>
            {formatRub(r.advertRub)}
            {r.drrPct > 0 && (
              <span className="ml-1 text-[11px]">({r.drrPct}%)</span>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {r.cogsRub > 0 ? (
          formatRub(r.cogsRub)
        ) : r.nmId > 0 && r.saleQty > 0 ? (
          <span className="text-amber-400" title="Себестоимость не заполнена — прибыль завышена">
            нет себест.
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className={cn("px-2 py-2 text-right font-medium tabular-nums", profitClass(r.profitRub))}>
        {formatRub(r.profitRub)}
      </td>
      <td className={cn("px-2 py-2 text-right tabular-nums", profitClass(r.profitRub))}>
        {r.revenueRub !== 0 ? `${r.marginPct}%` : "—"}
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
        {r.cogsRub > 0 ? `${r.roiPct}%` : "—"}
      </td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Экономика товаров</h1>
          <p className="text-sm text-muted-foreground">
            Факт из отчётов WB: реализация, комиссия, логистика, хранение,
            приёмка, реклама, себестоимость → прибыль по каждому товару
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border/60 p-0.5">
          {PERIODS.map((p) => (
            <Link
              key={p.days}
              href={`/economics?days=${p.days}`}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition",
                view.days === p.days
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className={cn("text-xl font-semibold tabular-nums", k.cls)}>
                {k.value}
              </div>
              {k.sub && <div className="text-xs text-muted-foreground">{k.sub}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Период: {view.from} — {view.to}
        </span>
        <Badge variant="outline" className="text-[10px]">
          хранение: {view.storageSource === "daily" ? "детально по товарам" : "из финотчёта"}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            view.costCoveragePct >= 95 ? "text-emerald-400" : "text-amber-400",
          )}
        >
          себестоимость заполнена у {view.costCoveragePct}% продаж
        </Badge>
      </div>

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0">
          {rows.length === 0 && !view.unallocated ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              Данных за период нет — дождитесь синхронизации финансов WB.
            </p>
          ) : (
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-normal">Товар</th>
                  <Th label="Продано" k="saleQty" />
                  <Th label="Выручка" k="revenueRub" />
                  <Th label="Комиссия" k="commissionRub" />
                  <Th label="Логистика" k="logisticsRub" />
                  <Th label="Хранение" k="storageRub" />
                  <th className="whitespace-nowrap px-2 py-2 text-right font-normal">
                    Прочее
                  </th>
                  <Th label="Реклама" k="advertRub" />
                  <Th label="Себест." k="cogsRub" />
                  <Th label="Прибыль" k="profitRub" />
                  <Th label="Маржа" k="marginPct" />
                  <Th label="ROI" k="roiPct" className="px-4" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.nmId} r={r} />
                ))}
                {view.unallocated && <Row r={view.unallocated} muted />}
                <tr className="bg-muted/20 font-medium">
                  <td className="px-4 py-2">Итого</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatNumber(t.saleQty)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatRub(t.revenueRub)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" colSpan={4}>
                    удержания {formatRub(t.wbFeesRub)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatRub(t.advertRub)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatRub(t.cogsRub)}
                  </td>
                  <td className={cn("px-2 py-2 text-right tabular-nums", profitClass(t.profitRub))}>
                    {formatRub(t.profitRub)}
                  </td>
                  <td className={cn("px-2 py-2 text-right tabular-nums", profitClass(t.profitRub))}>
                    {t.marginPct}%
                  </td>
                  <td className="px-4 py-2" />
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
