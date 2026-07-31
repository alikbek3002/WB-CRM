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
import {
  AXIS_TICK,
  GRID_STROKE,
  SERIES,
  TOOLTIP_STYLE,
} from "@/frontend/components/charts/palette";
import { formatNumber, formatRub } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { FinanceRow, PnlView } from "@/shared/types";

const compactRub = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)} млн`
    : Math.abs(v) >= 1_000
      ? `${Math.round(v / 1_000)} тыс`
      : String(v);

const REVENUE_COLOR = SERIES[0];
const NET_COLOR = SERIES[1];

function PnlTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: { label: string; revenue: number; net: number; opex: number } }[];
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="font-medium">{p.label}</div>
      <div>Выручка: {formatRub(p.revenue)}</div>
      <div>Расходы: {formatRub(p.opex)}</div>
      <div style={{ color: p.net >= 0 ? "#34d399" : "#f87171" }}>
        Чистая прибыль: {formatRub(p.net)}
      </div>
    </div>
  );
}

// Строка ОПиУ: показатель × месяцы. Знак задаётся отдельно — расходы всегда
// показываем со минусом, чтобы отчёт читался как в 1С/Excel.
function PnlRow({
  label,
  values,
  total,
  negative = false,
  strong = false,
  hint,
}: {
  label: string;
  values: number[];
  total: number;
  negative?: boolean;
  strong?: boolean;
  hint?: string;
}) {
  const fmt = (v: number) => (negative && v > 0 ? `−${formatRub(v)}` : formatRub(v));
  return (
    <TableRow className={cn(strong && "bg-muted/40")}>
      <TableCell className={cn("sticky left-0 bg-background", strong && "font-medium")}>
        {label}
        {hint && <div className="text-[11px] font-normal text-muted-foreground">{hint}</div>}
      </TableCell>
      {values.map((v, i) => (
        <TableCell
          key={i}
          className={cn(
            "text-right tabular-nums",
            negative && "text-muted-foreground",
            strong && "font-medium",
            strong && !negative && (v >= 0 ? "text-emerald-400" : "text-red-400"),
          )}
        >
          {fmt(v)}
        </TableCell>
      ))}
      <TableCell
        className={cn(
          "text-right font-medium tabular-nums",
          negative && "text-muted-foreground",
          strong && (total >= 0 ? "text-emerald-400" : "text-red-400"),
        )}
      >
        {fmt(total)}
      </TableCell>
    </TableRow>
  );
}

export function PnlReport({ view, wbRows }: { view: PnlView; wbRows: FinanceRow[] }) {
  const { months, total } = view;
  const points = months.map((m) => ({
    label: m.label.split(" ")[0],
    revenue: m.revenueRub,
    net: m.netRub,
    opex: m.opexRub,
  }));

  const kpis = [
    { label: "Выручка за 6 мес.", value: formatRub(total.revenueRub), className: "" },
    {
      label: "Валовая прибыль",
      value: formatRub(total.grossRub),
      hint: "после комиссии WB и себестоимости",
      className: total.grossRub >= 0 ? "" : "text-red-400",
    },
    {
      label: "Чистая прибыль",
      value: formatRub(total.netRub),
      hint: "после всех расходов компании",
      className: total.netRub >= 0 ? "text-emerald-400" : "text-red-400",
    },
    {
      label: "Рентабельность",
      value: `${total.marginPct}%`,
      hint: "чистая прибыль к выручке",
      className:
        total.marginPct >= 15
          ? "text-emerald-400"
          : total.marginPct >= 5
            ? "text-amber-400"
            : "text-red-400",
    },
  ];

  // Честные предупреждения: без них цифра прибыли вводит в заблуждение
  const warnings: { text: string; tone: "warn" | "info" }[] = [];
  if (view.costCoveragePct < 95) {
    warnings.push({
      tone: "warn",
      text:
        `Себестоимость заполнена только у ${view.costCoveragePct}% проданных товаров — ` +
        "прибыль завышена. Заполните себестоимость в разделе «Товары».",
    });
  }
  if (!view.hasExpenses) {
    warnings.push({
      tone: "warn",
      text: "Расходы компании не внесены — прибыль показана без рекламы, зарплат и налогов. Добавьте их на вкладке «Расходы».",
    });
  }
  if (view.advertSpendRub > 0) {
    warnings.push({
      tone: "info",
      text: `По данным кабинета WB на рекламу за период потрачено ${formatRub(view.advertSpendRub)} — проверьте, что эта сумма внесена в расходы.`,
    });
  }

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
              {k.hint && <div className="text-[11px] text-muted-foreground">{k.hint}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      {warnings.map((w) => (
        <p
          key={w.text}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            w.tone === "warn"
              ? "border-amber-500/40 bg-amber-500/5 text-amber-400"
              : "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          {w.tone === "warn" ? (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 size-3.5 shrink-0" />
          )}
          {w.text}
        </p>
      ))}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Выручка и чистая прибыль по месяцам
            <span className="ml-2 font-normal text-muted-foreground">
              столбцы — выручка, линия — прибыль
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={points}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <YAxis
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactRub}
                width={60}
              />
              <Tooltip content={<PnlTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="revenue" name="Выручка" fill={REVENUE_COLOR} radius={[3, 3, 0, 0]} />
              <Line
                dataKey="net"
                name="Чистая прибыль"
                stroke={NET_COLOR}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background">Показатель</TableHead>
                {months.map((m) => (
                  <TableHead key={m.month} className="text-right whitespace-nowrap">
                    {m.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Итого</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <PnlRow
                label="Выручка (продажи WB)"
                values={months.map((m) => m.revenueRub)}
                total={total.revenueRub}
              />
              <PnlRow
                label="Удержания WB"
                hint="комиссия и эквайринг по факту продаж"
                values={months.map((m) => m.wbFeesRub)}
                total={total.wbFeesRub}
                negative
              />
              <PnlRow
                label="Себестоимость товара"
                hint={`заполнена у ${view.costCoveragePct}% продаж`}
                values={months.map((m) => m.cogsRub)}
                total={total.cogsRub}
                negative
              />
              <PnlRow
                label="Валовая прибыль"
                values={months.map((m) => m.grossRub)}
                total={total.grossRub}
                strong
              />
              <PnlRow
                label="Расходы компании"
                hint="реклама, зарплаты, логистика, налоги…"
                values={months.map((m) => m.opexRub)}
                total={total.opexRub}
                negative
              />
              {total.otherIncomeRub > 0 && (
                <PnlRow
                  label="Прочие доходы"
                  values={months.map((m) => m.otherIncomeRub)}
                  total={total.otherIncomeRub}
                />
              )}
              <PnlRow
                label="Чистая прибыль"
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
            <CardTitle className="text-sm">На что уходят деньги (за период)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {view.expenseSlices.slice(0, 12).map((s) => (
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
                    {formatRub(s.amountRub)}
                    <span className="ml-2 text-xs text-muted-foreground">{s.sharePct}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${Math.min(100, s.sharePct)}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {wbRows.length > 0 && (
        <Card className="py-0">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-sm">Детализация отчётов WB</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Период</TableHead>
                  <TableHead className="text-right">Продажи</TableHead>
                  <TableHead className="text-right">Комиссия</TableHead>
                  <TableHead className="text-right">Логистика</TableHead>
                  <TableHead className="text-right">Хранение</TableHead>
                  <TableHead className="text-right">Штрафы</TableHead>
                  <TableHead className="text-right">К перечислению</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wbRows.map((r) => (
                  <TableRow key={r.period}>
                    <TableCell className="font-medium">{r.period}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRub(r.salesRub)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      −{formatRub(r.commissionRub)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      −{formatRub(r.logisticsRub)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      −{formatRub(r.storageRub)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      −{formatRub(r.penaltyRub)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatRub(r.toPayRub)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
