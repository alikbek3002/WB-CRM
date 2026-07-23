import { Avatar, AvatarFallback } from "@/frontend/components/ui/avatar";
import { Badge } from "@/frontend/components/ui/badge";
import { LogoutButton } from "@/frontend/components/layout/logout-button";
import { RoleSwitcher } from "@/frontend/components/layout/role-switcher";
import type { Session } from "@/backend/auth/session";

export function AppHeader({ session }: { session: Session }) {
  const initials = session.user.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{session.org.name}</span>
        <Badge variant="secondary" className="text-[10px]">
          Wildberries
        </Badge>
        {session.isDemo && (
          <Badge
            variant="outline"
            className="border-amber-500/50 text-[10px] text-amber-400"
          >
            Демо-данные
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Личный кабинет — переключатель ролей скрыт, есть «Выйти» */}
        {!session.authenticated && <RoleSwitcher role={session.role} />}
        <div className="flex items-center gap-2">
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div className="hidden leading-tight sm:block">
            <div className="text-xs font-medium">{session.user.name}</div>
            <div className="text-[11px] text-muted-foreground">
              {session.roleLabel}
            </div>
          </div>
        </div>
        {session.authenticated && <LogoutButton />}
      </div>
    </header>
  );
}
