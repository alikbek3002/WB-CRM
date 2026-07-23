import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { Input } from "@/frontend/components/ui/input";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { WbSyncButton } from "@/frontend/components/integrations/wb-sync-button";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getIntegrations } from "@/backend/data";
import { getWbToken } from "@/backend/wb/client";

function formatSyncTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  pending: {
    label: "Ожидает ключ",
    className: "border-amber-500/50 text-amber-400",
  },
  valid: { label: "Подключено", className: "border-emerald-500/50 text-emerald-400" },
  invalid: { label: "Ошибка", className: "border-red-500/50 text-red-400" },
};

export default async function IntegrationsPage() {
  const session = await getSession();
  if (!can(session.role, "integrations:manage")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const integrations = await getIntegrations();
  const wbTokenSet = Boolean(getWbToken());

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Интеграции</h1>
        <p className="text-sm text-muted-foreground">
          API-ключи хранятся зашифрованными в Supabase Vault — в БД только
          vault_secret_id (раздел 13 плана)
        </p>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        {integrations.map((integration) => {
          const badge = STATUS_BADGE[integration.status];
          return (
            <Card key={integration.provider}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-sm">
                  {integration.title}
                  <Badge variant="outline" className={`text-[10px] ${badge.className}`}>
                    {badge.label}
                  </Badge>
                </CardTitle>
                <CardDescription>{integration.hint}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {integration.scopes.map((s) => (
                    <Badge key={s} variant="secondary" className="text-[10px]">
                      {s}
                    </Badge>
                  ))}
                </div>
                {integration.provider === "wb" && wbTokenSet ? (
                  <div className="flex items-center gap-2">
                    <WbSyncButton />
                  </div>
                ) : (
                  <form className="flex gap-2">
                    <Input
                      type="password"
                      placeholder={
                        integration.provider === "wb"
                          ? "JWT-токен WB (или WB_API_TOKEN в .env.local)"
                          : integration.provider === "claude"
                            ? "sk-ant-…"
                            : "Токен бота"
                      }
                      disabled={session.isDemo}
                    />
                    <Button type="submit" size="sm" disabled={session.isDemo}>
                      Проверить
                    </Button>
                  </form>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {integration.provider === "wb" && wbTokenSet
                    ? integration.lastSyncAt
                      ? `Последняя синхронизация: ${formatSyncTime(integration.lastSyncAt)}`
                      : "Токен настроен (.env.local). Запустите первую синхронизацию."
                    : session.isDemo
                      ? "Демо-режим: ввод ключей активируется после настройки Supabase (.env.local)."
                      : integration.lastSyncAt
                        ? `Последняя синхронизация: ${formatSyncTime(integration.lastSyncAt)}`
                        : "Синхронизация ещё не выполнялась."}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
