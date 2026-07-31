"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { AddTxButton, type AccountOpt } from "@/frontend/components/finance/tx-dialog";
import { formatMoney, formatRub } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { ExpenseCategory, ExpensesView } from "@/shared/types";

// Готовые периоды: месяц открывается по умолчанию, остальное — в один клик
function periodPresets() {
  const now = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const quarterStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  return [
    { label: "Этот месяц", from: iso(monthStart), to: iso(now) },
    { label: "Прошлый месяц", from: iso(prevStart), to: iso(prevEnd) },
    { label: "3 месяца", from: iso(quarterStart), to: iso(now) },
    { label: "Год", from: iso(yearStart), to: iso(now) },
  ];
}

const dmy = (iso: string) => iso.split("-").reverse().join(".");

export function ExpensesBoard({
  view,
  accounts,
  categories,
  canEdit,
}: {
  view: ExpensesView;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const presets = periodPresets();
  const active = presets.find((p) => p.from === view.from && p.to === view.to);

  async function remove(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/finance/cash/tx?id=${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? "Ошибка");
      toast.success("Операция удалена");
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось удалить: ${(e as Error).message}`);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={active?.label === p.label ? "default" : "outline"}
              onClick={() => router.push(`/finance/expenses?from=${p.from}&to=${p.to}`)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <AddTxButton
              kind="out"
              label="Добавить расход"
              accounts={accounts}
              categories={categories}
              lockKind
            />
            <AddTxButton
              kind="in"
              label="Поступление"
              variant="outline"
              accounts={accounts}
              categories={categories}
              lockKind
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">
              Расходы за {dmy(view.from)} — {dmy(view.to)}
            </div>
            <div className="text-xl font-semibold tabular-nums">{formatRub(view.totalRub)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Влияют на прибыль</div>
            <div className="text-xl font-semibold tabular-nums">{formatRub(view.opexRub)}</div>
            <div className="text-[11px] text-muted-foreground">
              без закупа товара и выплат владельцу
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Операций</div>
            <div className="text-xl font-semibold tabular-nums">{view.items.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Самая крупная статья</div>
            <div className="truncate text-xl font-semibold">
              {view.categories[0]
                ? `${view.categories[0].emoji ?? ""} ${view.categories[0].name}`.trim()
                : "—"}
            </div>
            {view.categories[0] && (
              <div className="text-[11px] text-muted-foreground">
                {formatRub(view.categories[0].amountRub)} · {view.categories[0].sharePct}%
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {view.categories.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">По статьям</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {view.categories.map((c) => (
              <div key={c.name} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>
                    {c.emoji ? `${c.emoji} ` : ""}
                    {c.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {c.txCount} оп.
                      {!c.inPnl && " · не влияет на прибыль"}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {formatRub(c.amountRub)}
                    <span className="ml-2 text-xs text-muted-foreground">{c.sharePct}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", c.inPnl ? "bg-primary/70" : "bg-muted-foreground/40")}
                    style={{ width: `${Math.min(100, c.sharePct)}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Дата</TableHead>
                <TableHead>Статья</TableHead>
                <TableHead>Комментарий</TableHead>
                <TableHead>Счёт</TableHead>
                <TableHead>Кто внёс</TableHead>
                <TableHead className="text-right">Сумма</TableHead>
                {canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canEdit ? 7 : 6}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    За этот период расходов нет.
                    {canEdit && " Нажмите «Добавить расход» — или продиктуйте боту в Telegram."}
                  </TableCell>
                </TableRow>
              )}
              {view.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap">{dmy(t.occurredOn)}</TableCell>
                  <TableCell>
                    {t.categoryEmoji ? `${t.categoryEmoji} ` : ""}
                    {t.categoryName ?? "Без статьи"}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {t.note ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {t.accountName}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {t.authorName ?? "—"}
                    {t.source === "bot" || t.source === "ai" ? " · бот" : ""}
                  </TableCell>
                  <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                    {t.currency === "rub"
                      ? formatRub(t.amountRub)
                      : `${formatMoney(t.amount, t.currency)} (${formatRub(t.amountRub)})`}
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={deleting === t.id}
                        onClick={() => remove(t.id)}
                        aria-label="Удалить операцию"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
