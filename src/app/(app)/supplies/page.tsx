import { NoAccess } from "@/frontend/components/layout/no-access";
import { SuppliesBoard } from "@/frontend/components/supplies/supplies-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import {
  getCurrencyRates,
  getFactories,
  getFulfillmentPartners,
  getProductList,
  getSupplies,
  getUnloadPoints,
  getWbWarehouses,
} from "@/backend/data";
import { ratesToMap } from "@/backend/data/currency-core";

export default async function SuppliesPage() {
  const session = await getSession();
  if (!can(session.role, "supply:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [supplies, factories, products, partners, unloadPoints, wbWarehouses, currency] =
    await Promise.all([
      getSupplies(),
      getFactories(),
      getProductList(),
      getFulfillmentPartners(),
      getUnloadPoints(),
      getWbWarehouses(),
      getCurrencyRates(),
    ]);

  const canEdit = can(session.role, "supply:edit");
  const canPay = can(session.role, "supply:pay");
  const canReceive = can(session.role, "supply:receive");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Поставки</h1>
        <p className="text-sm text-muted-foreground">
          Карточки отгрузки: фабрика → в пути → приёмка в Москве → склады WB. Оплаты товара и карго.
          {!canEdit && " · только просмотр"}
        </p>
      </div>

      <SuppliesBoard
        supplies={supplies}
        factories={factories.map((f) => ({
          id: f.id,
          name: f.name,
          country: f.country,
          currency: f.currency,
        }))}
        products={products.map((p) => ({
          id: p.id,
          title: p.title,
          vendorCode: p.vendorCode,
          nmId: p.nmId,
          photoUrl: p.photoUrl,
        }))}
        partners={partners
          .filter((p) => !p.archived)
          .map((p) => ({
            id: p.id,
            name: p.name,
            ratePerUnitRub: p.ratePerUnitRub,
            city: p.city,
          }))}
        unloadPoints={unloadPoints}
        wbWarehouses={wbWarehouses}
        rates={ratesToMap(currency)}
        canEdit={canEdit}
        canPay={canPay}
        canReceive={canReceive}
      />
    </div>
  );
}
