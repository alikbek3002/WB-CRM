"use client";

import { useTransition } from "react";
import { ChevronDown, ShieldCheck, UserCog } from "lucide-react";
import { setDemoRole } from "@/app/actions/session";
import { Button } from "@/frontend/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/frontend/components/ui/dropdown-menu";
import { ROLE_LABELS, type MemberRole } from "@/shared/rbac";

// Демо-переключатель панелей: Директор (owner) ⇄ Старший менеджер (manager).
// После подключения Supabase Auth роль будет приходить из org_members.
const SWITCHABLE: MemberRole[] = ["owner", "manager", "analyst", "viewer"];

export function RoleSwitcher({ role }: { role: MemberRole }) {
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" disabled={pending}>
            {role === "owner" ? (
              <ShieldCheck className="size-4" />
            ) : (
              <UserCog className="size-4" />
            )}
            Панель: {ROLE_LABELS[role]}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Просмотр от лица роли</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SWITCHABLE.map((r) => (
          <DropdownMenuItem
            key={r}
            disabled={r === role}
            onClick={() => startTransition(() => setDemoRole(r))}
          >
            {ROLE_LABELS[r]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
