import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import {
  OrdersBarChart,
  OrdersLineChart,
  StocksDonut,
} from "@/frontend/components/dashboard/charts";
import { FiltersBar } from "@/frontend/components/dashboard/filters-bar";
import { KpiCards } from "@/frontend/components/dashboard/kpi-cards";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getDashboardData } from "@/backend/data";

export default async function DashboardPage() {
  const session = await getSession();
  if (!can(session.role, "dashboard:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const data = await getDashboardData();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Дашборд</h1>
        <p className="text-sm text-muted-foreground">
          Сводка по магазину · данные на{" "}
          {new Date(data.updatedAt).toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>

      <FiltersBar />
      <KpiCards kpis={data.kpis} />

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Динамика заказов</CardTitle>
            <CardDescription>Сумма заказов по дням, ₽</CardDescription>
          </CardHeader>
          <CardContent>
            <OrdersBarChart data={data.ordersDynamics} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              Остатки по складам
              <Link
                href="/stocks"
                className="text-xs font-normal text-muted-foreground hover:text-foreground"
              >
                Все склады и товары →
              </Link>
            </CardTitle>
            <CardDescription>Топ складов WB, шт</CardDescription>
          </CardHeader>
          <CardContent>
            {data.stocksByWarehouse.length > 0 ? (
              <StocksDonut data={data.stocksByWarehouse} />
            ) : (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                Остатков пока нет — появятся после приёмки поставок или
                синхронизации складов WB.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Заказы за период</CardTitle>
          <CardDescription>Тренд суммы заказов, ₽</CardDescription>
        </CardHeader>
        <CardContent>
          <OrdersLineChart data={data.ordersTrend} />
        </CardContent>
      </Card>
    </div>
  );
}
