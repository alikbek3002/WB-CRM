"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CreditCard,
  Landmark,
  Repeat,
  Wallet,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Input } from "@/frontend/components/ui/input";
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
import { AddTxButton } from "@/frontend/components/finance/tx-dialog";
import { StatRow } from "@/frontend/components/finance/stat-row";
import {
  AXIS_TICK,
  GRID_STROKE,
  SERIES,
  TOOLTIP_STYLE,
} from "@/frontend/components/charts/palette";
import { formatAmount, formatMoney, formatRub } from "@/shared/format";
import { cn } from "@/shared/utils";
import type {
  CashAccountKind,
  CashOverview,
  CashTxKind,
  Currency,
  ExpenseCategory,
} from "@/shared/types";

const ACCOUNT_ICON: Record<CashAccountKind, typeof Wallet> = {
  cash: Banknote,
  bank: Landmark,
  card: CreditCard,
  wb: Wallet,
  other: Wallet,
};

const ACCOUNT_KIND_LABEL: Record<CashAccountKind, string> = {
  cash: "Наличные",
  bank: "Счёт в банке",
  card: "Карта",
  wb: "Кабинет WB",
  other: "Прочее",
};

const TX_ICON: Record<CashTxKind, typeof ArrowUpRight> = {
  in: ArrowDownLeft,
  out: ArrowUpRight,
  transfer: Repeat,
};

const compactRub = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)} млн`
    : Math.abs(v) >= 1_000
      ? `${Math.round(v / 1_000)} тыс`
      : String(v);

const dmy = (iso: string) => iso.split("-").reverse().join(".");

function FlowTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: { label: string; in: number; out: number } }[];
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="font-medium">{p.label}</div>
      <div>Приход: {formatRub(p.in)}</div>
      <div>Расход: {formatRub(p.out)}</div>
      <div style={{ color: p.in - p.out >= 0 ? "#34d399" : "#f87171" }}>
        Итог: {formatRub(p.in - p.out)}
      </div>
    </div>
  );
}

// Заведение нового счёта (наличные, банк, карта, кошелёк в юанях)
function AccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CashAccountKind>("cash");
  const [currency, setCurrency] = useState<Currency>("rub");
  const [opening, setOpening] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error("Укажите название счёта");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/finance/cash/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          currency,
          openingBalance: Number(opening.replace(/\s/g, "").replace(",", ".")) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Ошибка");
      toast.success("Счёт создан");
      setName("");
      setOpening("");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось создать счёт: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый счёт</DialogTitle>
          <DialogDescription>
            Счёт — это место, где лежат деньги: касса в офисе, счёт в банке, карта,
            кошелёк в юанях для карго.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="acc-name">Название</Label>
            <Input
              id="acc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Каспи директора"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Тип</Label>
            <Select value={kind} onValueChange={(v) => v && setKind(v as CashAccountKind)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACCOUNT_KIND_LABEL) as CashAccountKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {ACCOUNT_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Валюта</Label>
            <Select value={currency} onValueChange={(v) => v && setCurrency(v as Currency)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rub">Рубли ₽</SelectItem>
                <SelectItem value="cny">Юани ¥</SelectItem>
                <SelectItem value="uzs">Сумы</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="acc-opening">Остаток сейчас</Label>
            <Input
              id="acc-opening"
              inputMode="decimal"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              placeholder="Сколько денег на счёте на сегодня"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Сохранение…" : "Создать счёт"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CashBoard({
  overview,
  categories,
  canEdit,
}: {
  overview: CashOverview;
  categories: ExpenseCategory[];
  canEdit: boolean;
}) {
  const [accountDialog, setAccountDialog] = useState(false);
  const accountOpts = overview.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
  }));
  const points = overview.flow.map((f) => ({ label: f.label, in: f.inRub, out: f.outRub }));
  const monthNet = overview.monthInRub - overview.monthOutRub;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          Остатки считаются от заведённого остатка счёта плюс все операции
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <AddTxButton
              kind="out"
              label="Расход"
              accounts={accountOpts}
              categories={categories}
            />
            <AddTxButton
              kind="in"
              label="Поступление"
              variant="outline"
              accounts={accountOpts}
              categories={categories}
              lockKind
            />
            <AddTxButton
              kind="transfer"
              label="Перевод"
              variant="outline"
              accounts={accountOpts}
              categories={categories}
              lockKind
            />
            <Button size="sm" variant="outline" onClick={() => setAccountDialog(true)}>
              Новый счёт
            </Button>
          </div>
        )}
      </div>

      <StatRow
        stats={[
          {
            label: "Всего денег",
            value: formatRub(overview.totalRub),
            hint: `по ${overview.accounts.length} счетам`,
          },
          {
            label: "Пришло за месяц",
            value: formatRub(overview.monthInRub),
            tone: "good",
          },
          {
            label: "Потрачено за месяц",
            value: formatRub(overview.monthOutRub),
            tone: "bad",
          },
          {
            label: "Итог месяца",
            value: `${monthNet >= 0 ? "+" : ""}${formatRub(monthNet)}`,
            tone: monthNet >= 0 ? "good" : "bad",
            hint: "приход минус расход",
          },
          ...(overview.wbBalance
            ? [
                {
                  label: "В кабинете WB",
                  value: formatAmount(overview.wbBalance.current, overview.wbBalance.currency),
                  hint: "маркетплейс ещё не перечислил",
                  tone: "muted" as const,
                },
              ]
            : []),
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Счета</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.accounts.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Счетов пока нет. Нажмите «Новый счёт» и укажите, сколько денег есть сейчас.
              </p>
            )}
            {overview.wbBalance && (
              <div className="flex items-center justify-between rounded-lg border border-dashed border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Wallet className="size-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">Кабинет Wildberries</div>
                    <div className="text-[11px] text-muted-foreground">
                      ещё не перечислено · проверено {dmy(overview.wbBalance.checkedAt.slice(0, 10))}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium tabular-nums">
                    {formatAmount(overview.wbBalance.current, overview.wbBalance.currency)}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    к выводу {formatAmount(overview.wbBalance.forWithdraw, overview.wbBalance.currency)}
                  </div>
                </div>
              </div>
            )}
            {overview.accounts.map((a) => {
              const Icon = ACCOUNT_ICON[a.kind];
              return (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm font-medium">{a.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {ACCOUNT_KIND_LABEL[a.kind]} · {a.txCount} операций
                        {a.lastTx ? ` · последняя ${dmy(a.lastTx)}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={cn(
                        "font-medium tabular-nums",
                        a.balance < 0 && "text-red-400",
                      )}
                    >
                      {formatMoney(a.balance, a.currency)}
                    </div>
                    {a.currency !== "rub" && (
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        ≈ {formatRub(a.balanceRub)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Деньги по месяцам
              <span className="ml-2 font-normal text-muted-foreground">
                приход и расход, ₽
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {points.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Операций пока нет.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={points} barGap={2}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={compactRub}
                    width={56}
                  />
                  <Tooltip content={<FlowTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="in" name="Приход" fill={SERIES[1]} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="out" name="Расход" fill={SERIES[5]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm">Последние операции</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Дата</TableHead>
                <TableHead>Операция</TableHead>
                <TableHead>Счёт</TableHead>
                <TableHead>Комментарий</TableHead>
                <TableHead className="text-right">Сумма</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                    Операций пока нет.
                  </TableCell>
                </TableRow>
              )}
              {overview.recent.map((t) => {
                const Icon = TX_ICON[t.kind];
                return (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap">{dmy(t.occurredOn)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <Icon
                          className={cn(
                            "size-4",
                            t.kind === "in"
                              ? "text-emerald-400"
                              : t.kind === "out"
                                ? "text-red-400"
                                : "text-muted-foreground",
                          )}
                        />
                        {t.kind === "transfer"
                          ? `Перевод → ${t.toAccountName ?? "—"}`
                          : `${t.categoryEmoji ? `${t.categoryEmoji} ` : ""}${t.categoryName ?? (t.kind === "in" ? "Поступление" : "Расход")}`}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {t.accountName}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {t.note ?? "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-medium whitespace-nowrap tabular-nums",
                        t.kind === "in" && "text-emerald-400",
                        t.kind === "out" && "text-red-400",
                      )}
                    >
                      {t.kind === "in" ? "+" : t.kind === "out" ? "−" : ""}
                      {t.currency === "rub"
                        ? formatRub(t.amountRub)
                        : formatMoney(t.amount, t.currency)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AccountDialog open={accountDialog} onOpenChange={setAccountDialog} />
    </div>
  );
}
