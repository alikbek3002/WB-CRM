import { RnpView } from "@/frontend/components/rnp/rnp-view";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getRnpProducts } from "@/backend/data";

export default async function RnpPage() {
  const session = await getSession();
  if (!can(session.role, "rnp:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const products = await getRnpProducts();
  const canEdit = can(session.role, "rnp:edit");

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            РНП · Рабочий недельный план
          </h1>
          <p className="text-sm text-muted-foreground">
            План/факт по SKU, юнит-экономика и воронка
            {!canEdit && " · только просмотр"}
          </p>
        </div>
      </div>
      <RnpView products={products} canEdit={canEdit} />
    </div>
  );
}
