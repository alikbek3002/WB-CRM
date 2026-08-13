"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { UserRound } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import { Label } from "@/frontend/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import {
  AddTxButton,
  type AccountOpt,
  type MemberOpt,
} from "@/frontend/components/finance/tx-dialog";
import { StatRow } from "@/frontend/components/finance/stat-row";
import { StructureBar } from "@/frontend/components/finance/structure-bar";
import { SERIES } from "@/frontend/components/charts/palette";
import { BASE_CURRENCY, type CurrencyRateMap } from "@/shared/currency";
import { formatMoney, formatSom } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { ExpenseCategory, PayrollView } from "@/shared/types";

const ALL = "__all__";

// Те же периоды, что на «Расходах» — привычка одна на весь раздел финансов
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

const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

export function PayrollBoard({
  view,
  accounts,
  categories,
  members,
  rates,
  canEdit,
}: {
  view: PayrollView;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  members: MemberOpt[];
  rates?: CurrencyRateMap; // курсы к сому для формы выплаты
  canEdit: boolean;
}) {
  const router = useRouter();
  const [personId, setPersonId] = useState<string>(ALL);
  const presets = periodPresets();
  const active = presets.find((p) => p.from === view.from && p.to === view.to);

  // После смены периода выбранного человека может не быть в новом списке —
  // тогда фильтр откатывается на «Все», иначе в селекте останется сырой uuid
  const effectivePersonId = view.people.some((p) => p.personId === personId)
    ? personId
    : ALL;
  const selected = view.people.find((p) => p.personId === effectivePersonId) ?? null;
  // Если статью «Зарплата» переименовали — берём любую зарплатную, не пустоту
  const salaryCategory =
    categories.find((c) => c.isPayroll && c.name === "Зарплата") ??
    categories.find((c) => c.isPayroll);

  const items = useMemo(
    () =>
      effectivePersonId === ALL
        ? view.items
        : view.items.filter((t) => t.personId === effectivePersonId),
    [view.items, effectivePersonId],
  );

  const avgPerPerson = view.people.length ? Math.round(view.totalRub / view.people.length) : 0;
  const top = view.people[0];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={active?.label === p.label ? "default" : "outline"}
              onClick={() => router.push(`/finance/payroll?from=${p.from}&to=${p.to}`)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        {canEdit && (
          <AddTxButton
            rates={rates}
            // key пересоздаёт кнопку с диалогом при смене выбранного сотрудника:
            // useState в TxDialog берёт default* только при монтировании
            key={selected?.personId ?? "none"}
            kind="out"
            label="Начислить выплату"
            accounts={accounts}
            categories={categories}
            members={members}
            defaultCategoryId={salaryCategory?.id ?? ""}
            defaultPersonId={selected?.personId ?? ""}
            lockKind
          />
        )}
      </div>

      <StatRow
        stats={[
          {
            label: `Выплачено команде · ${dmy(view.from)} — ${dmy(view.to)}`,
            value: formatSom(view.totalRub),
            hint: `${view.people.length} чел. · ${view.items.length} выплат`,
          },
          {
            label: "Больше всех получил",
            value: top ? top.name : "—",
            hint: top ? `${formatSom(top.amountRub)} · ${top.sharePct}%` : undefined,
          },
          {
            label: "В среднем на человека",
            value: avgPerPerson ? formatSom(avgPerPerson) : "—",
            hint: "за выбранный период",
            tone: "muted",
          },
          {
            label: "Ждёт выплаты",
            value: formatSom(view.pendingRub),
            hint: "заявки без оплаты",
            tone: view.pendingRub > 0 ? "bad" : "default",
          },
        ]}
      />

      {view.unassignedRub > 0 && (
        <Card>
          <CardContent className="py-3 text-sm text-amber-400">
            {formatSom(view.unassignedRub)} по «людским» статьям ({view.unassignedCount}{" "}
            {view.unassignedCount === 1 ? "операция" : "операций"}) записаны без сотрудника —
            в разрезе по людям их не видно. Указывайте, кому выплата, при вводе расхода.
          </CardContent>
        </Card>
      )}

      {view.people.length > 1 && (
        <Card>
          <CardContent className="py-4">
            <div className="mb-2 text-sm">
              Как распределился фонд выплат
              <span className="ml-2 text-muted-foreground">от {formatSom(view.totalRub)}</span>
            </div>
            <StructureBar
              total={view.totalRub}
              formatValue={(v) => formatSom(v)}
              segments={view.people.slice(0, 6).map((p, i) => ({
                label: p.name,
                value: p.amountRub,
                color: SERIES[i % SERIES.length],
              }))}
            />
          </CardContent>
        </Card>
      )}

      {view.people.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            За этот период выплат сотрудникам нет.
            {canEdit && (
              <>
                <br />
                Нажмите «Начислить выплату» — или напишите боту:{" "}
                <span className="text-foreground">«начисли Азизу зарплату 60 тысяч»</span>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {view.people.map((p) => (
            <Card
              key={p.personId}
              className={cn(
                "cursor-pointer transition-colors hover:border-foreground/20",
                personId === p.personId && "border-foreground/40",
              )}
              onClick={() => setPersonId(personId === p.personId ? ALL : p.personId)}
            >
              <CardContent className="space-y-2 py-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium">
                      <UserRound className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{p.name}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{p.roleLabel}</div>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[11px]">
                    {p.sharePct}%
                  </Badge>
                </div>

                <div className="text-lg font-semibold tabular-nums">
                  {formatSom(p.amountRub)}
                </div>

                <div className="text-xs text-muted-foreground">
                  {p.txCount} {p.txCount === 1 ? "выплата" : "выплат"}
                  {p.lastPaidOn ? ` · последняя ${dmy(p.lastPaidOn)}` : ""}
                </div>

                {p.slices.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {p.slices.slice(0, 4).map((s) => (
                      <span
                        key={`${p.personId}-${s.categoryId ?? s.name}`}
                        className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {s.emoji ? `${s.emoji} ` : ""}
                        {s.name} — {formatSom(s.amountRub)}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="py-0">
        <CardContent className="space-y-3 px-0 py-4">
          <div className="flex flex-wrap items-end justify-between gap-2 px-4">
            <div className="grid min-w-56 gap-1.5">
              <Label>Смотреть выплаты по сотруднику</Label>
              <Select value={effectivePersonId} onValueChange={(v) => setPersonId(v ?? ALL)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Все сотрудники" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все сотрудники</SelectItem>
                  {view.people.map((p) => (
                    <SelectItem key={p.personId} value={p.personId}>
                      {p.name} — {formatSom(p.amountRub)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selected && (
              <div className="text-sm text-muted-foreground">
                {selected.name}: {formatSom(selected.amountRub)} за период
                {selected.monthly.length > 1
                  ? ` · по месяцам ${selected.monthly
                      .map((m) => `${m.label} ${formatSom(m.amountRub)}`)
                      .join(" · ")}`
                  : ""}
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Дата</TableHead>
                  <TableHead>Кому</TableHead>
                  <TableHead>Статья</TableHead>
                  <TableHead>Комментарий</TableHead>
                  <TableHead>Счёт</TableHead>
                  <TableHead className="text-right">Сумма</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      Выплат за этот период нет.
                    </TableCell>
                  </TableRow>
                )}
                {items.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap">{dmy(t.occurredOn)}</TableCell>
                    <TableCell className="whitespace-nowrap">{t.personName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {t.categoryEmoji ? `${t.categoryEmoji} ` : ""}
                      {t.categoryName ?? "Без статьи"}
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">
                      {t.note ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {t.accountName}
                      {t.source === "bot" || t.source === "ai" ? " · бот" : ""}
                    </TableCell>
                    <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                      {t.currency === BASE_CURRENCY
                        ? formatSom(t.amountRub)
                        : `${formatMoney(t.amount, t.currency)} (${formatSom(t.amountRub)})`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
