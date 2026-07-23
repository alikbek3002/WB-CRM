import { Card, CardContent } from "@/frontend/components/ui/card";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { FulfillmentList } from "@/frontend/components/fulfillment/fulfillment-list";
import { formatNumber } from "@/shared/format";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFulfillment } from "@/backend/data";

export default async function FulfillmentPage() {
  const session = await getSession();
  if (!can(session.role, "fulfillment:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const f = await getFulfillment();
  const canReceive = can(session.role, "supply:receive");

  const kpis = [
    { label: "Приняли, шт", value: f.receivedQty, tone: "text-foreground" },
    { label: "В разборе, шт", value: f.sortingQty, tone: "text-amber-400" },
    { label: "Лежит, шт", value: f.inStockQty, tone: "text-sky-300" },
    { label: "Распределено, шт", value: f.distributedQty, tone: "text-emerald-400" },
    { label: "Недостачи, шт", value: f.shortageQty, tone: "text-red-400" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Фул-фирма</h1>
        <p className="text-sm text-muted-foreground">
          Склад приёмки в Москве: сколько приняли, что в разборе, что лежит и распределено
          {!canReceive && " · только просмотр"}
        </p>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
        {kpis.map((k) => (
          <Card key={k.label} className="py-4">
            <CardContent className="px-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className={`mt-1 text-2xl font-semibold tabular-nums ${k.tone}`}>
                {formatNumber(k.value)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <FulfillmentList cards={f.cards} canReceive={canReceive} />
    </div>
  );
}
