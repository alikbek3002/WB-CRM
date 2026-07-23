import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { formatNumber, formatRub } from "@/shared/format";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getTariffs } from "@/backend/data";

export default async function TariffsPage() {
  const session = await getSession();
  if (!can(session.role, "tariffs:manage")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const tariffs = await getTariffs();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Тарифы</h1>
        <p className="text-sm text-muted-foreground">
          Лимиты проверяются перед действиями: магазины, товары, AI-токены,
          частота синхронизации (раздел 12 плана)
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tariffs.map((t) => (
          <Card key={t.code} className={t.current ? "border-primary/60" : ""}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                {t.name}
                {t.current && (
                  <Badge className="text-[10px]">Текущий</Badge>
                )}
              </CardTitle>
              <CardDescription>
                <span className="text-xl font-semibold text-foreground">
                  {t.priceMonth === 0 ? "0 ₽" : formatRub(t.priceMonth)}
                </span>{" "}
                / мес
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5 text-xs text-muted-foreground">
              <div>Магазинов: {t.maxStores}</div>
              <div>
                Товаров: {t.maxProducts ? formatNumber(t.maxProducts) : "без лимита"}
              </div>
              <div>AI-токенов: {formatNumber(t.aiTokensMonth)} / мес</div>
              <div>Синхронизация: каждые {t.syncIntervalMin} мин</div>
              <Button
                className="mt-3 w-full"
                size="sm"
                variant={t.current ? "outline" : "default"}
                disabled={t.current || session.isDemo}
              >
                {t.current ? "Подключён" : "Выбрать"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
