import { NoAccess } from "@/frontend/components/layout/no-access";
import { SuppliesBoard } from "@/frontend/components/supplies/supplies-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFactories, getProductList, getSupplies } from "@/backend/data";

export default async function SuppliesPage() {
  const session = await getSession();
  if (!can(session.role, "supply:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [supplies, factories, products] = await Promise.all([
    getSupplies(),
    getFactories(),
    getProductList(),
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
        factories={factories.map((f) => ({ id: f.id, name: f.name, country: f.country }))}
        products={products.map((p) => ({ id: p.id, title: p.title }))}
        canEdit={canEdit}
        canPay={canPay}
        canReceive={canReceive}
      />
    </div>
  );
}
