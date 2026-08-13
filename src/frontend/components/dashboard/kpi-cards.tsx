import { Card, CardContent } from "@/frontend/components/ui/card";
import { formatNumber, formatPercent, formatSom } from "@/shared/format";
import type { DashboardKpis } from "@/shared/types";

type Kpi = {
  title: string;
  value: string;
  sub: string;
};

export function KpiCards({ kpis }: { kpis: DashboardKpis }) {
  const items: Kpi[] = [
    {
      title: "Чистая прибыль",
      value: formatSom(kpis.profitRub),
      sub: `рентабельность ${formatPercent(kpis.profitabilityPct)}`,
    },
    {
      title: "Продажи / Выкупы",
      value: formatSom(kpis.salesRub),
      sub: `${formatNumber(kpis.salesQty)} шт`,
    },
    {
      title: "Заказы",
      value: formatSom(kpis.ordersRub),
      sub: `${formatNumber(kpis.ordersQty)} шт`,
    },
    {
      title: "Остатки на складе",
      value: `${formatNumber(kpis.stockQty)} шт`,
      sub: `${kpis.stockWarehouses} складов WB`,
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((kpi) => (
        <Card key={kpi.title} className="py-4">
          <CardContent className="px-4">
            <div className="text-xs text-muted-foreground">{kpi.title}</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight">
              {kpi.value}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {kpi.sub}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
