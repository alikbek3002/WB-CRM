"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Coins, Receipt, Target, Users, Wallet } from "lucide-react";
import { cn } from "@/shared/utils";

// Вкладки раздела «Финансы». Ссылки, а не клиентские табы: каждая вкладка —
// своя серверная страница со своими данными (не тянем всё сразу).
const TABS = [
  { href: "/finance", label: "План WB", icon: Target, cashOnly: false },
  { href: "/finance/pnl", label: "Прибыль (ОПиУ)", icon: BarChart3, cashOnly: true },
  { href: "/finance/expenses", label: "Расходы", icon: Receipt, cashOnly: true },
  { href: "/finance/payroll", label: "Выплаты команде", icon: Users, cashOnly: true },
  { href: "/finance/cash", label: "Касса", icon: Wallet, cashOnly: true },
  // Курсы валют к сому: базовая валюта одна, а платят фабрикам в юанях и долларах
  { href: "/finance/currencies", label: "Валюты", icon: Coins, cashOnly: true },
];

export function FinanceNav({ canCash }: { canCash: boolean }) {
  const pathname = usePathname();
  const tabs = TABS.filter((t) => canCash || !t.cashOnly);

  return (
    <nav className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
      {tabs.map((t) => {
        const active = pathname === t.href;
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
