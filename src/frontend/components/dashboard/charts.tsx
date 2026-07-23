"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_TICK,
  GRID_STROKE,
  PRIMARY,
  SERIES,
  TOOLTIP_STYLE,
} from "@/frontend/components/charts/palette";
import { formatNumber, formatRub } from "@/shared/format";
import type { DailyPoint, WarehouseStock } from "@/shared/types";

const compactRub = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`
    : `${Math.round(v / 1000)} тыс`;

type TooltipPayload = { payload?: DailyPoint }[];

function DailyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayload;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="font-medium">{point.label}</div>
      <div className="mt-1 text-muted-foreground">
        Сумма: <span className="text-foreground">{formatRub(point.sumRub)}</span>
      </div>
      <div className="text-muted-foreground">
        Заказы: <span className="text-foreground">{formatNumber(point.qty)} шт</span>
      </div>
    </div>
  );
}

// «Динамика заказов» — столбцы по дням (одна ось: ₽; шт — в тултипе)
export function OrdersBarChart({ data }: { data: DailyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={compactRub}
          width={52}
        />
        <Tooltip content={<DailyTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
        <Bar
          dataKey="sumRub"
          fill={PRIMARY}
          radius={[4, 4, 0, 0]}
          maxBarSize={18}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// «Заказы за период» — линия тренда (одна ось: ₽; шт — в тултипе)
export function OrdersLineChart({ data }: { data: DailyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={compactRub}
          width={52}
        />
        <Tooltip
          content={<DailyTooltip />}
          cursor={{ stroke: "rgba(255,255,255,0.2)", strokeDasharray: "3 3" }}
        />
        <Line
          type="monotone"
          dataKey="sumRub"
          stroke={PRIMARY}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, stroke: "#1a1a19", strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// «Остатки по складам» — донат + легенда с прямыми подписями и значениями
// (CVD-палитра в floor band → подписи обязательны, зазор 2px между сегментами)
export function StocksDonut({ data }: { data: WarehouseStock[] }) {
  const total = data.reduce((s, w) => s + w.qty, 0);

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[220px] w-[220px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="qty"
              nameKey="warehouse"
              innerRadius={62}
              outerRadius={95}
              stroke="var(--card)"
              strokeWidth={2}
              paddingAngle={1}
            >
              {data.map((entry, i) => (
                <Cell key={entry.warehouse} fill={SERIES[i % SERIES.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => [
                `${formatNumber(Number(value))} шт`,
                undefined,
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-lg font-semibold">{formatNumber(total)}</div>
          <div className="text-[11px] text-muted-foreground">шт всего</div>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
        {data.map((w, i) => (
          <li key={w.warehouse} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: SERIES[i % SERIES.length] }}
            />
            <span className="truncate text-muted-foreground">{w.warehouse}</span>
            <span className="ml-auto font-medium tabular-nums">
              {formatNumber(w.qty)}
            </span>
            <span className="w-10 text-right text-muted-foreground tabular-nums">
              {(total > 0 ? (w.qty / total) * 100 : 0).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
