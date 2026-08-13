import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import { Badge } from "@/frontend/components/ui/badge";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { FactoryForm } from "@/frontend/components/factory/factory-form";
import { CURRENCY_LABEL } from "@/shared/currency";
import { formatNumber, formatSom } from "@/shared/format";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFactories } from "@/backend/data";
import type { SupplyCountry } from "@/shared/types";

const COUNTRY: Record<SupplyCountry, string> = {
  china: "Китай 🇨🇳",
  uzbekistan: "Узбекистан 🇺🇿",
};

export default async function FactoryPage() {
  const session = await getSession();
  if (!can(session.role, "factory:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const factories = await getFactories();
  const canEdit = can(session.role, "factory:edit");

  const totalShipped = factories.reduce((t, f) => t + f.shippedQty, 0);
  const totalSum = factories.reduce((t, f) => t + f.shippedSumRub, 0);
  const totalInTransit = factories.reduce((t, f) => t + f.inTransitCount, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Фабрики</h1>
          <p className="text-sm text-muted-foreground">
            Производители (Китай / Узбекистан): сколько отшили, на какую сумму (в сомах по
            курсу из «Валют»), что в пути
            {!canEdit && " · только просмотр"}
          </p>
        </div>
        {canEdit && <FactoryForm />}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="py-4">
          <CardContent className="px-4">
            <div className="text-xs text-muted-foreground">Всего отшито</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatNumber(totalShipped)} шт
            </div>
          </CardContent>
        </Card>
        <Card className="py-4">
          <CardContent className="px-4">
            <div className="text-xs text-muted-foreground">Сумма отшивки + карго, сом</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{formatSom(totalSum)}</div>
          </CardContent>
        </Card>
        <Card className="py-4">
          <CardContent className="px-4">
            <div className="text-xs text-muted-foreground">Поставок в пути</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{totalInTransit}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {factories.map((f) => (
          <Card key={f.id} className="py-4">
            <CardHeader className="px-4">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{f.name}</CardTitle>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {CURRENCY_LABEL[f.currency]}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {COUNTRY[f.country]}
                  </Badge>
                </div>
              </div>
              {f.note && <p className="text-xs text-muted-foreground">{f.note}</p>}
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 sm:grid-cols-4">
              <Metric label="Отшито, шт" value={formatNumber(f.shippedQty)} />
              <Metric label="Сумма, сом" value={formatSom(f.shippedSumRub)} />
              <Metric label="Поставок" value={String(f.suppliesCount)} />
              <Metric label="В пути" value={String(f.inTransitCount)} />
              <Metric
                label="Ср. время в пути"
                value={f.avgTransitDays != null ? `${f.avgTransitDays} дн` : "—"}
              />
            </CardContent>
          </Card>
        ))}
        {factories.length === 0 && (
          <Card className="py-8">
            <CardContent className="px-4 text-center text-sm text-muted-foreground">
              Фабрик пока нет. {canEdit && "Добавьте первую фабрику."}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums">{value}</div>
    </div>
  );
}
