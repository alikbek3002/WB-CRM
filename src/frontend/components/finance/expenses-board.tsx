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
import { StatRow } from "@/frontend/components/finance/stat-row";
import { StructureBar } from "@/frontend/components/finance/structure-bar";
import { SERIES } from "@/frontend/components/charts/palette";
import { formatMoney, formatRub } from "@/shared/format";
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

      <StatRow
        stats={[
          {
            label: `Расходы · ${dmy(view.from)} — ${dmy(view.to)}`,
            value: formatRub(view.totalRub),
            hint: `${view.items.length} операций`,
          },
          {
            label: "Влияют на прибыль",
            value: formatRub(view.opexRub),
            hint: "без закупа товара и выплат владельцу",
          },
          {
            label: "Крупнейшая статья",
            value: view.categories[0]
              ? `${view.categories[0].emoji ?? ""} ${view.categories[0].name}`.trim()
              : "—",
            hint: view.categories[0]
              ? `${formatRub(view.categories[0].amountRub)} · ${view.categories[0].sharePct}%`
              : undefined,
          },
          {
            label: "Средний расход",
            value: view.items.length
              ? formatRub(Math.round(view.totalRub / view.items.length))
              : "—",
            hint: "на одну операцию",
            tone: "muted",
          },
        ]}
      />

      {view.categories.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Структура расходов
              <span className="ml-2 font-normal text-muted-foreground">
                доля каждой статьи от {formatRub(view.totalRub)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StructureBar
              total={view.totalRub}
              formatValue={(v) => formatRub(v)}
              segments={view.categories.slice(0, 6).map((c, i) => ({
                label: c.name,
                value: c.amountRub,
                color: SERIES[i % SERIES.length],
              }))}
            />
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
