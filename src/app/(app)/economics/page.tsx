import { NoAccess } from "@/frontend/components/layout/no-access";
import { EconomicsView } from "@/frontend/components/economics/economics-view";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getUnitEconomics } from "@/backend/data";

export const dynamic = "force-dynamic";

// Юнит-экономика по товарам: все деньги из отчётов WB, разложенные по nm_id.
// Право как у финансов: цифры прибыли — не для всей команды.
export default async function EconomicsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await getSession();
  if (!can(session.role, "finance:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const params = await searchParams;
  const days = params.days === "90" ? 90 : params.days === "7" ? 7 : 30;
  const view = await getUnitEconomics(days);

  return <EconomicsView view={view} />;
}
