import { NoAccess } from "@/frontend/components/layout/no-access";
import { PayoutsBoard } from "@/frontend/components/finance/payouts-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFinanceRefs, getFactories, getPayouts, getSupplies } from "@/backend/data";

// Выплаты: сотрудник просит деньги (зарплата, подрядчик, счёт фабрики),
// руководитель согласовывает и оплачивает — оплата уходит прямо в кассу.
export default async function PayoutsPage() {
  const session = await getSession();
  if (!can(session.role, "payout:request")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const canApprove = can(session.role, "payout:approve");
  const [view, refs, factories, supplies] = await Promise.all([
    getPayouts({ id: session.user.id, role: session.role }),
    getFinanceRefs(),
    can(session.role, "factory:view") ? getFactories() : Promise.resolve([]),
    can(session.role, "supply:view") ? getSupplies() : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Выплаты</h1>
        <p className="text-sm text-muted-foreground">
          {canApprove
            ? "Заявки команды и фабрик: согласование и оплата — деньги списываются из кассы"
            : "Запросите выплату — руководитель увидит заявку сразу и ответит в Telegram"}
        </p>
      </div>

      <PayoutsBoard
        view={view}
        canApprove={canApprove}
        currentUserId={session.user.id}
        accounts={refs.accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        categories={refs.categories.filter((c) => c.direction === "out")}
        factories={factories.map((f) => ({ id: f.id, name: f.name }))}
        supplies={supplies
          .filter((s) => s.status !== "cancelled")
          .slice(0, 100)
          .map((s) => ({ id: s.id, title: s.title, factoryName: s.factoryName }))}
      />
    </div>
  );
}
