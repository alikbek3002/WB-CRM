import { NoAccess } from "@/frontend/components/layout/no-access";
import { DesignBoard } from "@/frontend/components/design/design-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getDesignRequests, getProductList } from "@/backend/data";

export const dynamic = "force-dynamic";

// Дизайн карточек: менеджеры создают заявки (товар + бриф + референсы),
// дизайнер берёт в работу и сдаёт макет, директор/ст. менеджер утверждают.
export default async function DesignPage() {
  const session = await getSession();
  if (!can(session.role, "design:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [requests, productList] = await Promise.all([
    getDesignRequests(),
    getProductList(),
  ]);
  const products = productList.map((p) => ({ id: p.id, title: p.title }));

  const canRequest = can(session.role, "design:request");
  const canSubmit = can(session.role, "design:submit");
  const canApprove = can(session.role, "design:approve");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Дизайн карточек</h1>
        <p className="text-sm text-muted-foreground">
          Заявка с референсами → дизайнер сдаёт макет → утверждение руководителем
        </p>
      </div>

      <DesignBoard
        requests={requests}
        products={products}
        canRequest={canRequest}
        canSubmit={canSubmit}
        canApprove={canApprove}
      />
    </div>
  );
}
