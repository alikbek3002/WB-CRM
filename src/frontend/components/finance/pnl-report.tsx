"use client";

import { AlertTriangle, Info } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { HeroStat, StatRow, type Stat } from "@/frontend/components/finance/stat-row";
import { StructureBar } from "@/frontend/components/finance/structure-bar";
import { AXIS_TICK, GRID_STROKE, SERIES, TOOLTIP_STYLE } from "@/frontend/components/charts/palette";
import { formatAmount, formatCompact, formatNumber } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { PnlView } from "@/shared/types";

// Цвета структуры выручки. Порядок фиксирован (dataviz: идентичность не зависит
// от ранга), пара «расходы ↔ прибыль» разнесена подписями и зазорами — без них
// она слабо различима при протанопии.
const C_WB = SERIES[0]; // удержания WB — синий
const C_COGS = SERIES[2]; // себестоимость — жёлтый
const C_ADV = SERIES[4]; // реклама — фиолетовый
const C_OPEX = SERIES[5]; // расходы компании — красный
const C_NET = SERIES[1]; // прибыль — зелёный

function PnlTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: { payload?: { label: string; revenue: number; net: number; costs: number } }[];
  currency: string;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="font-medium">{p.label}</div>
      <div>Выручка: {formatAmount(p.revenue, currency)}</div>
      <div>Затраты: {formatAmount(p.costs, currency)}</div>
      <div style={{ color: p.net >= 0 ? "#34d399" : "#f87171" }}>
        Прибыль: {formatAmount(p.net, currency)}
      </div>
    </div>
  );
}

// Строка отчёта: показатель × месяцы. Расходные строки печатаем со знаком минус —
// так отчёт читается как в бухгалтерии, без гадания «это вычитается или нет».
function PnlRow({
  label,
  values,
  total,
  currency,
  negative = false,
  strong = false,
  indent = false,
  hint,
}: {
  label: string;
  values: number[];
  total: number;
  currency: string;
  negative?: boolean;
  strong?: boolean;
  indent?: boolean;
  hint?: string;
}) {
  const fmt = (v: number) =>
    negative && v > 0 ? `−${formatAmount(v, currency)}` : formatAmount(v, currency);
  return (
    <TableRow className={cn(strong && "bg-muted/40")}>
      <TableCell
        className={cn(
          "sticky left-0 bg-background whitespace-nowrap",
          strong && "font-medium",
          indent && "pl-8 text-muted-foreground",
        )}
      >
        {label}
        {hint && <div className="text-[11px] font-normal text-muted-foreground">{hint}</div>}
      </TableCell>
      {values.map((v, i) => (
        <TableCell
          key={i}
          className={cn(
            "text-right whitespace-nowrap tabular-nums",
            negative && "text-muted-foreground",
            indent && "text-muted-foreground",
            strong && "font-medium",
            strong && !negative && (v >= 0 ? "text-emerald-400" : "text-red-400"),
          )}
        >
          {fmt(v)}
        </TableCell>
      ))}
      <TableCell
        className={cn(
          "text-right font-medium whitespace-nowrap tabular-nums",
          negative && "text-muted-foreground",
          strong && (total >= 0 ? "text-emerald-400" : "text-red-400"),
        )}
      >
        {fmt(total)}
      </TableCell>
    </TableRow>
  );
}

// Последний день месяца по его первому дню (yyyy-mm-01)
function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function PnlReport({ view }: { view: PnlView }) {
  const { months, total, currency } = view;
  const money = (v: number) => formatAmount(v, currency);

  const points = months.map((m) => ({
    label: m.label.split(" ")[0],
    revenue: m.revenueRub,
    net: m.netRub,
    costs: m.wbFeesRub + m.cogsRub + m.advertRub + m.opexRub,
  }));

  // Последний месяц с продажами — «текущий» для дельт
  const withSales = months.filter((m) => m.revenueRub > 0);
  const last = withSales[withSales.length - 1];
  const prev = withSales[withSales.length - 2];
  // Сравнивать можно только закрытые месяцы: в текущем удержания WB пришли
  // не за все продажи, поэтому его «рост прибыли» — артефакт, а не результат.
  const monthClosed = (m: (typeof months)[number] | undefined) =>
    Boolean(m && m.source === "wb_report" && view.reportUntil && view.reportUntil >= monthEnd(m.month));
  const deltaPct =
    last && prev && prev.netRub !== 0 && monthClosed(last) && monthClosed(prev)
      ? Math.round(((last.netRub - prev.netRub) / Math.abs(prev.netRub)) * 100)
      : null;

  const drrPct = total.revenueRub > 0 ? (total.advertRub / total.revenueRub) * 100 : 0;

  const stats: Stat[] = [
    { label: "Выручка", value: money(total.revenueRub), hint: `${formatNumber(total.qty)} шт продано` },
    {
      label: "Удержания WB",
      value: money(total.wbFeesRub),
      hint:
        total.revenueRub > 0
          ? `${Math.round((total.wbFeesRub / total.revenueRub) * 100)}% от выручки`
          : undefined,
      tone: "muted",
    },
    {
      label: "Себестоимость",
      value: money(total.cogsRub),
      hint:
        view.costCoveragePct < 100 ? `заполнена у ${view.costCoveragePct}% продаж` : undefined,
      tone: "muted",
    },
    {
      label: "Валовая прибыль",
      value: money(total.grossRub),
      hint: "после WB и себестоимости",
      tone: total.grossRub >= 0 ? "default" : "bad",
    },
    { label: "Реклама WB", value: money(total.advertRub), hint: `ДРР ${drrPct.toFixed(1)}%`, tone: "muted" },
    { label: "Расходы компании", value: money(total.opexRub), hint: "из кассы", tone: "muted" },
    {
      label: "Рентабельность",
      value: `${total.marginPct}%`,
      hint: "чистая прибыль к выручке",
      tone: total.marginPct >= 15 ? "good" : total.marginPct >= 5 ? "default" : "bad",
    },
    {
      label: last ? `Прибыль · ${last.label.split(" ")[0]}` : "Прибыль за месяц",
      value: last ? money(last.netRub) : "—",
      tone: last && last.netRub >= 0 ? "good" : "bad",
      delta:
        deltaPct !== null
          ? { text: `${deltaPct >= 0 ? "+" : ""}${deltaPct}% к прошлому`, good: deltaPct >= 0 }
          : undefined,
    },
  ];

  // Честные оговорки: без них цифра прибыли вводит в заблуждение
  const notes: { text: string; tone: "warn" | "info" }[] = [];
  if (view.costCoveragePct < 95) {
    notes.push({
      tone: "warn",
      text: `Себестоимость заполнена у ${view.costCoveragePct}% проданных товаров — прибыль завышена. Заполните её в разделе «Товары».`,
    });
  }
  if (!view.hasWbReport) {
    notes.push({
      tone: "warn",
      text: "Отчёт о реализации WB ещё не загружен — удержания показаны оценкой (выручка минус «к перечислению»), без логистики, хранения и штрафов.",
    });
  } else {
    const names = months
      .filter((m) => m.revenueRub > 0 && m.source === "estimate")
      .map((m) => m.label.split(" ")[0])
      .join(", ");
    if (names) {
      notes.push({
        tone: "info",
        text: `За ${names} отчёта WB нет — удержания за эти месяцы оценочные и уточнятся после выгрузки.`,
      });
    }
    if (view.reportUntil) {
      notes.push({
        tone: "info",
        text: `WB посчитал удержания по ${view.reportUntil.split("-").reverse().join(".")}. Продажи после этой даты уже в выручке, но их комиссия и логистика ещё не пришли — прибыль последних дней завышена.`,
      });
    }
  }
  if (!view.hasExpenses) {
    notes.push({
      tone: "info",
      text: "Расходы компании не внесены — прибыль без зарплат, налогов и внешней рекламы. Добавьте их на вкладке «Расходы».",
    });
  }
  if (currency !== "RUB") {
    notes.push({
      tone: "info",
      text:
        `Кабинет WB ведёт расчёты в валюте ${currency} — суммы отчёта показаны в ней, а не в рублях.` +
        (total.advertRub > 0
          ? " Расход на рекламу приходит из статистики кампаний — сверьте его с кабинетом, если там другая валюта."
          : "") +
        " Расходы компании и касса считаются в рублях.",
    });
  }

  return (
    <div className="space-y-3">
      <HeroStat
        label={`Чистая прибыль · ${months.length} мес.`}
        value={money(total.netRub)}
        tone={total.netRub >= 0 ? "good" : "bad"}
        caption={`Выручка ${money(total.revenueRub)} · рентабельность ${total.marginPct}%${
          view.hasWbReport ? " · по отчётам WB" : " · оценка до загрузки отчёта WB"
        }`}
        aside={
          view.wbBalance && (
            <div className="text-right">
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">
                Баланс кабинета WB
              </div>
              <div className="text-xl font-semibold tabular-nums">
                {formatAmount(view.wbBalance.current, view.wbBalance.currency)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                к выводу {formatAmount(view.wbBalance.forWithdraw, view.wbBalance.currency)}
              </div>
            </div>
          )
        }
      />

      <StatRow stats={stats} />

      {total.revenueRub > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Куда уходит выручка
              <span className="ml-2 font-normal text-muted-foreground">
                доля каждой части от {money(total.revenueRub)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StructureBar
              total={total.revenueRub}
              formatValue={money}
              segments={[
                { label: "Удержания WB", value: total.wbFeesRub, color: C_WB },
                { label: "Себестоимость", value: total.cogsRub, color: C_COGS },
                { label: "Реклама WB", value: total.advertRub, color: C_ADV },
                { label: "Расходы компании", value: total.opexRub, color: C_OPEX },
                { label: "Чистая прибыль", value: Math.max(0, total.netRub), color: C_NET },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {notes.map((n) => (
        <p
          key={n.text}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            n.tone === "warn"
              ? "border-amber-500/40 bg-amber-500/5 text-amber-400"
              : "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          {n.tone === "warn" ? (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 size-3.5 shrink-0" />
          )}
          {n.text}
        </p>
      ))}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Выручка и прибыль по месяцам
            <span className="ml-2 font-normal text-muted-foreground">
              столбцы — выручка, линия — чистая прибыль
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <YAxis
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatCompact}
                width={64}
              />
              <Tooltip
                content={<PnlTooltip currency={currency} />}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
              />
              <Bar dataKey="revenue" name="Выручка" fill={C_WB} radius={[4, 4, 0, 0]} maxBarSize={44} />
              <Line
                dataKey="net"
                name="Чистая прибыль"
                stroke={C_NET}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0, fill: C_NET }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm">
            Отчёт о прибылях и убытках
            <span className="ml-2 font-normal text-muted-foreground">
              {view.hasWbReport ? "удержания — из отчётов WB" : "удержания — оценка"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background">Показатель</TableHead>
                {months.map((m) => (
                  <TableHead key={m.month} className="text-right whitespace-nowrap">
                    {m.label}
                    {m.revenueRub > 0 && m.source === "estimate" && (
                      <span className="ml-1 text-[10px] text-amber-400">оценка</span>
                    )}
                  </TableHead>
                ))}
                <TableHead className="text-right">Итого</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <PnlRow
                label="Выручка"
                currency={currency}
                values={months.map((m) => m.revenueRub)}
                total={total.revenueRub}
              />
              <PnlRow
                label="Удержания WB"
                currency={currency}
                values={months.map((m) => m.wbFeesRub)}
                total={total.wbFeesRub}
                negative
              />
              <PnlRow
                label="комиссия"
                currency={currency}
                values={months.map((m) => m.commissionRub)}
                total={total.commissionRub}
                negative
                indent
              />
              {total.acquiringRub > 0 && (
                <PnlRow
                  label="эквайринг"
                  currency={currency}
                  values={months.map((m) => m.acquiringRub)}
                  total={total.acquiringRub}
                  negative
                  indent
                />
              )}
              {total.logisticsRub > 0 && (
                <PnlRow
                  label="логистика"
                  currency={currency}
                  values={months.map((m) => m.logisticsRub)}
                  total={total.logisticsRub}
                  negative
                  indent
                />
              )}
              {total.storageRub > 0 && (
                <PnlRow
                  label="хранение"
                  currency={currency}
                  values={months.map((m) => m.storageRub)}
                  total={total.storageRub}
                  negative
                  indent
                />
              )}
              {total.penaltyRub > 0 && (
                <PnlRow
                  label="штрафы"
                  currency={currency}
                  values={months.map((m) => m.penaltyRub)}
                  total={total.penaltyRub}
                  negative
                  indent
                />
              )}
              {total.acceptanceRub > 0 && (
                <PnlRow
                  label="платная приёмка"
                  currency={currency}
                  values={months.map((m) => m.acceptanceRub)}
                  total={total.acceptanceRub}
                  negative
                  indent
                />
              )}
              {total.deductionRub !== 0 && (
                <PnlRow
                  label="прочие удержания"
                  currency={currency}
                  values={months.map((m) => m.deductionRub)}
                  total={total.deductionRub}
                  negative
                  indent
                />
              )}
              <PnlRow
                label="Себестоимость товара"
                currency={currency}
                hint={`заполнена у ${view.costCoveragePct}% продаж`}
                values={months.map((m) => m.cogsRub)}
                total={total.cogsRub}
                negative
              />
              <PnlRow
                label="Валовая прибыль"
                currency={currency}
                values={months.map((m) => m.grossRub)}
                total={total.grossRub}
                strong
              />
              <PnlRow
                label="Реклама WB"
                currency={currency}
                hint="из статистики кампаний"
                values={months.map((m) => m.advertRub)}
                total={total.advertRub}
                negative
              />
              <PnlRow
                label="Расходы компании"
                currency={currency}
                hint="зарплаты, налоги, услуги — из кассы"
                values={months.map((m) => m.opexRub)}
                total={total.opexRub}
                negative
              />
              {total.otherIncomeRub > 0 && (
                <PnlRow
                  label="Прочие доходы"
                  currency={currency}
                  values={months.map((m) => m.otherIncomeRub)}
                  total={total.otherIncomeRub}
                />
              )}
              <PnlRow
                label="Чистая прибыль"
                currency={currency}
                values={months.map((m) => m.netRub)}
                total={total.netRub}
                strong
              />
              <TableRow>
                <TableCell className="sticky left-0 bg-background text-muted-foreground">
                  Рентабельность
                </TableCell>
                {months.map((m) => (
                  <TableCell key={m.month} className="text-right tabular-nums">
                    {m.revenueRub > 0 ? `${m.marginPct}%` : "—"}
                  </TableCell>
                ))}
                <TableCell className="text-right font-medium tabular-nums">
                  {total.revenueRub > 0 ? `${total.marginPct}%` : "—"}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="sticky left-0 bg-background text-muted-foreground">
                  Продано, шт
                </TableCell>
                {months.map((m) => (
                  <TableCell key={m.month} className="text-right tabular-nums">
                    {formatNumber(m.qty)}
                  </TableCell>
                ))}
                <TableCell className="text-right font-medium tabular-nums">
                  {formatNumber(total.qty)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {view.expenseSlices.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Расходы компании по статьям</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {view.expenseSlices.slice(0, 10).map((s) => (
              <div key={s.name} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>
                    {s.emoji ? `${s.emoji} ` : ""}
                    {s.name}
                    {!s.inPnl && (
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        не влияет на прибыль
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    {formatAmount(s.amountRub, "RUB")}
                    <span className="ml-2 text-xs text-muted-foreground">{s.sharePct}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, s.sharePct)}%`,
                      backgroundColor: s.inPnl ? C_OPEX : "rgba(255,255,255,0.25)",
                    }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
