import { NoAccess } from "@/frontend/components/layout/no-access";
import { ProductForm } from "@/frontend/components/products/product-form";
import { ProductsView } from "@/frontend/components/products/products-view";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getProductGroups, getProductList } from "@/backend/data";

export default async function ProductsPage() {
  const session = await getSession();
  if (!can(session.role, "products:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [products, groups] = await Promise.all([
    getProductList(),
    getProductGroups(),
  ]);
  const canEdit = can(session.role, "products:edit");
  const canGroups = can(session.role, "products:groups");

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Товары</h1>
          <p className="text-sm text-muted-foreground">
            Каталог кабинета WB: фото, цены, остатки, скорость продаж, рекомендации ИИ
            {!canEdit && " · только просмотр"}
          </p>
        </div>
        {canEdit && <ProductForm />}
      </div>

      <ProductsView
        products={products}
        groups={groups}
        canEdit={canEdit}
        canGroups={canGroups}
      />
    </div>
  );
}
