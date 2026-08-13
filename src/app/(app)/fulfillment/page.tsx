import { Card, CardContent } from "@/frontend/components/ui/card";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { FulfillmentList } from "@/frontend/components/fulfillment/fulfillment-list";
import { FulfillmentPartners } from "@/frontend/components/fulfillment/fulfillment-partners";
import { formatNumber, formatSom } from "@/shared/format";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFulfillment, getFulfillmentPartners, getUnloadPoints } from "@/backend/data";

export default async function FulfillmentPage() {
  const session = await getSession();
  if (!can(session.role, "fulfillment:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [f, partners, unloadPoints] = await Promise.all([
    getFulfillment(),
    getFulfillmentPartners(),
    getUnloadPoints(),
  ]);
  const canReceive = can(session.role, "supply:receive");
  const canManage = can(session.role, "fulfillment:manage");
  // Города для подсказок: свои склады в кабинете WB + уже заведённые фул-фирмы
  const cities = unloadPoints.map((p) => p.city);

  const kpis = [
    { label: "Приняли, шт", value: formatNumber(f.receivedQty), tone: "text-foreground" },
    { label: "В разборе, шт", value: formatNumber(f.sortingQty), tone: "text-amber-400" },
    { label: "Лежит, шт", value: formatNumber(f.inStockQty), tone: "text-sky-300" },
    {
      label: "Распределено, шт",
      value: formatNumber(f.distributedQty),
      tone: "text-emerald-400",
    },
    { label: "Недостачи, шт", value: formatNumber(f.shortageQty), tone: "text-red-400" },
    // Деньги: до 0037 услуги фул-фирмы не учитывались нигде и завышали прибыль
    {
      label: "Начислено за услуги",
      value: formatSom(f.chargedRub),
      tone: "text-foreground",
      hint: "входит в себестоимость товара",
    },
    { label: "Оплачено", value: formatSom(f.paidRub), tone: "text-emerald-400" },
    {
      label: "Долг фул-фирме",
      value: formatSom(f.owedRub),
      tone: f.owedRub > 0 ? "text-amber-400" : "text-muted-foreground",
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Фул-фирма</h1>
        <p className="text-sm text-muted-foreground">
          Склады приёмки по городам: сколько приняли, что в разборе, что лежит и распределено,
          и во сколько обошлись услуги
          {!canReceive && " · только просмотр"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="py-4">
            <CardContent className="px-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className={`mt-1 text-2xl font-semibold tabular-nums ${k.tone}`}>
                {k.value}
              </div>
              {k.hint && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">{k.hint}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Куда разгружаем: по каким городам разошлись партии. Считается по всем
          поставкам, включая едущие, — казанская точка должна знать о карго,
          которое к ней приедет, заранее. */}
      {f.byCity.length > 0 && (
        <Card className="py-0">
          <CardContent className="space-y-2 px-4 py-4">
            <div>
              <div className="text-sm font-medium">Разгрузка по городам</div>
              <div className="text-xs text-muted-foreground">
                Города берутся из карточек поставок; справочник — свои склады в кабинете
                WB и заведённые фул-фирмы.
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {f.byCity.map((c) => (
                <div key={c.city} className="rounded-lg border border-border/60 px-3 py-2">
                  <div className="text-sm font-medium">
                    {c.city === "—" ? "Город не указан" : c.city}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatNumber(c.qty)} шт · {formatNumber(c.supplies)} парт.
                  </div>
                  {c.chargedRub > 0 && (
                    <div className="text-xs text-muted-foreground">
                      услуги {formatSom(c.chargedRub)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <FulfillmentPartners partners={partners} cities={cities} canManage={canManage} />
      <FulfillmentList cards={f.cards} canReceive={canReceive} />
    </div>
  );
}
