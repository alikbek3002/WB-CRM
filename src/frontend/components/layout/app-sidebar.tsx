"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  CalendarRange,
  ClipboardCheck,
  CreditCard,
  Factory,
  FileText,
  LayoutDashboard,
  ListChecks,
  Package,
  Palette,
  Plug,
  Truck,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { can, type MemberRole, type Permission } from "@/shared/rbac";
import { cn } from "@/shared/utils";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
};

type NavGroup = {
  section: string | null;
  items: NavItem[];
};

const NAV: NavGroup[] = [
  {
    section: null,
    items: [
      { href: "/dashboard", label: "Дашборд", icon: LayoutDashboard, permission: "dashboard:view" },
      { href: "/rnp", label: "РНП", icon: CalendarRange, permission: "rnp:view" },
      { href: "/products", label: "Товары", icon: Package, permission: "products:view" },
      { href: "/stocks", label: "Остатки", icon: Boxes, permission: "products:view" },
      { href: "/finance", label: "Финансы", icon: Wallet, permission: "finance:view" },
      { href: "/tasks", label: "Задачи", icon: ListChecks, permission: "tasks:view" },
      { href: "/duties", label: "Регламент", icon: ClipboardCheck, permission: "duty:view" },
      { href: "/design", label: "Дизайн", icon: Palette, permission: "design:view" },
      { href: "/reports", label: "Отчёты", icon: FileText, permission: "reports:view" },
    ],
  },
  {
    section: "Цепочка поставок",
    items: [
      { href: "/factory", label: "Фабрики", icon: Factory, permission: "factory:view" },
      { href: "/supplies", label: "Поставки", icon: Truck, permission: "supply:view" },
      { href: "/fulfillment", label: "Фул-фирма", icon: Warehouse, permission: "fulfillment:view" },
    ],
  },
  {
    section: "Управление",
    items: [
      { href: "/team", label: "Команда", icon: Users, permission: "team:manage" },
      { href: "/settings/integrations", label: "Интеграции", icon: Plug, permission: "integrations:manage" },
      { href: "/tariffs", label: "Тарифы", icon: CreditCard, permission: "tariffs:manage" },
    ],
  },
];

export function AppSidebar({
  role,
  dataSource,
}: {
  role: MemberRole;
  dataSource: "supabase" | "mock";
}) {
  const pathname = usePathname();
  const groups = NAV.map((g) => ({
    section: g.section,
    items: g.items.filter((item) => can(role, item.permission)),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className="flex h-svh w-56 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-600 text-xs font-bold text-white">
          WB
        </div>
        <span className="text-sm font-semibold tracking-tight">WB CRM</span>
      </div>

      <nav className="flex-1 space-y-3 overflow-y-auto p-2">
        {groups.map((group, gi) => (
          <div key={group.section ?? `group-${gi}`} className="space-y-0.5">
            {group.section && (
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {group.section}
              </div>
            )}
            {group.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    active && "bg-accent font-medium text-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
        {dataSource === "supabase" ? (
          <>
            Данные: Supabase (реальная БД).
            <br />
            Синхронизация WB — после подключения токена.
          </>
        ) : (
          <>
            Демо-режим: данные мок.
            <br />
            Заполните ключи Supabase в .env.local.
          </>
        )}
      </div>
    </aside>
  );
}
