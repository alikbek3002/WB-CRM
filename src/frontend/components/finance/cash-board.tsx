"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CreditCard,
  Hourglass,
  Landmark,
  Pencil,
  Repeat,
  Scale,
  Trash2,
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
import { AddTxButton, type MemberOpt } from "@/frontend/components/finance/tx-dialog";
import { StatRow } from "@/frontend/components/finance/stat-row";
import {
  AXIS_TICK,
  GRID_STROKE,
  SERIES,
  TOOLTIP_STYLE,
} from "@/frontend/components/charts/palette";
import {
  BASE_CURRENCY,
  CURRENCY_CODES,
  CURRENCY_LABEL,
  CURRENCY_SIGN,
  type CurrencyRateMap,
} from "@/shared/currency";
import { formatAmount, formatMoney, formatSom } from "@/shared/format";
import { cn } from "@/shared/utils";
import type {
  CashAccount,
  CashAccountKind,
  CashOverview,
  CashTx,
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

const todayIso = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
};

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
      <div>Приход: {formatSom(p.in)}</div>
      <div>Расход: {formatSom(p.out)}</div>
      <div style={{ color: p.in - p.out >= 0 ? "#34d399" : "#f87171" }}>
        Итог: {formatSom(p.in - p.out)}
      </div>
    </div>
  );
}

// Заведение нового счёта (наличные, банк, карта, кошелёк в юанях или долларах)
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
  const [currency, setCurrency] = useState<Currency>(BASE_CURRENCY);
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
        <div className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0">
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
                {CURRENCY_CODES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CURRENCY_LABEL[c]}
                  </SelectItem>
                ))}
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

// Сверка остатка — главный способ ввести деньги руками. Директор смотрит
// выписку (или пересчитывает наличные), вписывает фактический остаток, а разницу
// система пишет корректирующей операцией со статьёй «Сверка кассы». Правку
// начального остатка для этого не используем: она молча переписала бы историю,
// а сверка оставляет след в ленте операций.
function ReconcileDialog({
  account,
  open,
  onOpenChange,
}: {
  account: CashAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [actual, setActual] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const parsed = Number(actual.replace(/\s/g, "").replace(",", "."));
  const valid = actual.trim() !== "" && Number.isFinite(parsed);
  const diff = valid && account ? Math.round((parsed - account.balance) * 100) / 100 : 0;

  async function submit() {
    if (!account) return;
    if (!valid) {
      toast.error("Укажите фактический остаток");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/finance/cash/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          actualBalance: parsed,
          occurredOn,
          note: note.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(data?.message ?? "Остаток сверен");
      setActual("");
      setNote("");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось сверить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Сверка остатка{account ? ` · ${account.name}` : ""}</DialogTitle>
          <DialogDescription>
            Сколько денег на счёте на самом деле. Разницу с расчётом система запишет
            отдельной операцией «Сверка кассы» — прибыль периода она не меняет.
          </DialogDescription>
        </DialogHeader>

        {account && (
          <div className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0">
            <div className="rounded-lg border border-border/60 px-3 py-2 sm:col-span-2">
              <div className="text-[11px] text-muted-foreground">Расчётный остаток по системе</div>
              <div className="text-lg font-medium tabular-nums">
                {formatMoney(account.balance, account.currency)}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="rec-amount">Фактический остаток, {CURRENCY_SIGN[account.currency]}</Label>
              <Input
                id="rec-amount"
                inputMode="decimal"
                value={actual}
                onChange={(e) => setActual(e.target.value)}
                placeholder="Сколько есть по выписке"
                autoFocus
              />
              {valid && (
                <p
                  className={cn(
                    "text-[11px]",
                    diff === 0
                      ? "text-muted-foreground"
                      : diff > 0
                        ? "text-emerald-400"
                        : "text-red-400",
                  )}
                >
                  {diff === 0
                    ? "Совпадает с расчётом — операция не понадобится"
                    : `${diff > 0 ? "Добавим" : "Спишем"} ${formatMoney(Math.abs(diff), account.currency)}`}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="rec-date">Дата сверки</Label>
              <Input
                id="rec-date"
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
              />
            </div>

            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="rec-note">Комментарий</Label>
              <Input
                id="rec-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Например: по выписке банка за 14.08"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving || !valid}>
            {saving ? "Сохранение…" : "Сверить остаток"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Правка счёта: название, начальный остаток (с чего счёт начинался) и архив.
// Валюту менять нельзя — операции уже записаны в ней.
function EditAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account: CashAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [opening, setOpening] = useState("");
  const [saving, setSaving] = useState(false);

  // Диалог один на все счёта — при открытии подставляем поля выбранного
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (account && loadedFor !== account.id) {
    setLoadedFor(account.id);
    setName(account.name);
    setOpening("");
  }

  async function patch(body: Record<string, unknown>, okText: string) {
    if (!account) return;
    setSaving(true);
    try {
      const res = await fetch("/api/finance/cash/accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: account.id, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(okText);
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось сохранить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const openingNum = Number(opening.replace(/\s/g, "").replace(",", "."));

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Счёт{account ? ` · ${account.name}` : ""}</DialogTitle>
          <DialogDescription>
            Начальный остаток — сколько было на счёте до первой операции в системе.
            Чтобы просто поправить текущий остаток, лучше сделать сверку: она оставит
            след в операциях.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="acc-name">Название</Label>
            <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="acc-open">Начальный остаток{account ? `, ${CURRENCY_SIGN[account.currency]}` : ""}</Label>
            <Input
              id="acc-open"
              inputMode="decimal"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              placeholder="Оставьте пустым, чтобы не менять"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            onClick={() => patch({ archived: true }, "Счёт убран в архив")}
            disabled={saving}
          >
            В архив
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Отмена
            </Button>
            <Button
              onClick={() =>
                patch(
                  {
                    name: name.trim() || undefined,
                    openingBalance:
                      opening.trim() !== "" && Number.isFinite(openingNum) ? openingNum : undefined,
                  },
                  "Счёт обновлён",
                )
              }
              disabled={saving || (!name.trim() && opening.trim() === "")}
            >
              {saving ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Выплаты WB «в обработке»: WB сформировал отчёт и отправил деньги, но до
// расчётного счёта они ещё не дошли (до недели-двух). API момент зачисления
// не отдаёт — поступление подтверждают кнопкой, с датой фактического прихода.
// До подтверждения сумма не входит в остатки и ДДС.
function WbProcessingCard({ items, canEdit }: { items: CashTx[]; canEdit: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<CashTx | null>(null);
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [saving, setSaving] = useState(false);

  if (!items.length) return null;

  async function submit() {
    if (!confirming) return;
    setSaving(true);
    try {
      const res = await fetch("/api/finance/cash/tx", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "confirm_received",
          id: confirming.id,
          receivedOn: receivedOn || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Ошибка");
      toast.success(data?.message ?? "Поступление подтверждено");
      setConfirming(null);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось подтвердить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Hourglass className="size-4 text-amber-400" />
          Выплаты WB в обработке
          <span className="font-normal text-muted-foreground">
            WB отправил, на счёт ещё не поступили — в остатках не учтены
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
          >
            <div>
              <div className="text-sm font-medium tabular-nums">
                {formatMoney(t.amount, t.currency)}
                {t.currency !== BASE_CURRENCY && (
                  <span className="ml-1.5 font-normal text-[11px] text-muted-foreground">
                    ≈ {formatSom(t.amountRub)}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t.note ?? `выплата от ${dmy(t.occurredOn)}`}
              </div>
            </div>
            {canEdit ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setConfirming(t);
                  setReceivedOn(todayIso());
                }}
              >
                Поступили на счёт
              </Button>
            ) : (
              <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-400">
                в обработке
              </span>
            )}
          </div>
        ))}
      </CardContent>

      <Dialog open={!!confirming} onOpenChange={(o) => !o && !saving && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Деньги поступили на счёт</DialogTitle>
            <DialogDescription>
              {confirming
                ? `${formatMoney(confirming.amount, confirming.currency)} — ${confirming.note ?? "выплата WB"}. `
                : ""}
              Укажите дату зачисления по банковской выписке — приход встанет в кассу этим днём.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="received-on">Дата поступления</Label>
            <Input
              id="received-on"
              type="date"
              value={receivedOn}
              max={todayIso()}
              onChange={(e) => setReceivedOn(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving || !receivedOn}>
              {saving ? "Сохранение…" : "Подтвердить поступление"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function CashBoard({
  overview,
  categories,
  members = [],
  rates,
  canEdit,
}: {
  overview: CashOverview;
  categories: ExpenseCategory[];
  members?: MemberOpt[];
  rates?: CurrencyRateMap; // курсы к сому — форма операции показывает пересчёт
  canEdit: boolean;
}) {
  const router = useRouter();
  const [accountDialog, setAccountDialog] = useState(false);
  const [reconciling, setReconciling] = useState<CashAccount | null>(null);
  const [editing, setEditing] = useState<CashAccount | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Ошибочное поступление (например, старая выплата из API) удаляется здесь же:
  // касса должна сходиться с выпиской, а не хранить чужие цифры.
  async function removeTx(id: string) {
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
  const accountOpts = overview.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
  }));
  const points = overview.flow.map((f) => ({ label: f.label, in: f.inRub, out: f.outRub }));
  const monthNet = overview.monthInRub - overview.monthOutRub;
  const processing = overview.wbProcessing;
  const processingSum = processing.reduce((t, x) => t + x.amount, 0);
  const processingCur = processing[0]?.currency ?? BASE_CURRENCY;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-xl text-sm text-muted-foreground">
          Остатки считаются от заведённого остатка счёта плюс все операции. Деньги от WB
          в кассу автоматически не попадают: вносите поступление по выписке или
          нажмите «Сверка» у счёта и впишите фактический остаток.
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <AddTxButton
              kind="out"
              label="Расход"
              accounts={accountOpts}
              categories={categories}
              members={members}
              rates={rates}
            />
            <AddTxButton
              kind="in"
              label="Поступление"
              variant="outline"
              accounts={accountOpts}
              categories={categories}
              members={members}
              rates={rates}
              lockKind
            />
            <AddTxButton
              kind="transfer"
              label="Перевод"
              variant="outline"
              accounts={accountOpts}
              categories={categories}
              rates={rates}
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
            value: formatSom(overview.totalRub),
            hint: `по ${overview.accounts.length} счетам`,
          },
          {
            label: "Пришло за месяц",
            value: formatSom(overview.monthInRub),
            tone: "good",
          },
          {
            label: "Потрачено за месяц",
            value: formatSom(overview.monthOutRub),
            tone: "bad",
          },
          {
            label: "Итог месяца",
            value: `${monthNet >= 0 ? "+" : ""}${formatSom(monthNet)}`,
            tone: monthNet >= 0 ? "good" : "bad",
            hint: "приход минус расход",
          },
          ...(processing.length
            ? [
                {
                  label: "Выплаты WB в обработке",
                  value: formatMoney(processingSum, processingCur),
                  hint: "отправлены, но ещё не на счёте",
                  tone: "muted" as const,
                },
              ]
            : []),
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

      <WbProcessingCard items={processing} canEdit={canEdit} />

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
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <div
                        className={cn(
                          "font-medium tabular-nums",
                          a.balance < 0 && "text-red-400",
                        )}
                      >
                        {formatMoney(a.balance, a.currency)}
                      </div>
                      {a.currency !== BASE_CURRENCY && (
                        <div className="text-[11px] text-muted-foreground tabular-nums">
                          ≈ {formatSom(a.balanceRub)}
                        </div>
                      )}
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-0.5">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setReconciling(a)}
                          title="Вписать фактический остаток"
                        >
                          <Scale className="size-3.5" />
                          Сверка
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setEditing(a)}
                          aria-label="Изменить счёт"
                          title="Название, начальный остаток, архив"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
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
                приход и расход, сом
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
                {canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canEdit ? 6 : 5} className="py-12 text-center text-sm text-muted-foreground">
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
                        {t.status === "processing" && (
                          <span className="rounded-full border border-amber-500/40 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-amber-400">
                            в обработке
                          </span>
                        )}
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
                        t.status === "processing" && "text-muted-foreground",
                      )}
                    >
                      {t.kind === "in" ? "+" : t.kind === "out" ? "−" : ""}
                      {t.currency === BASE_CURRENCY
                        ? formatSom(t.amountRub)
                        : formatMoney(t.amount, t.currency)}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="text-right">
                        {/* Оплаты поставок и заявок правятся в своих карточках —
                            там у них вторая половина записи (сервер тоже откажет) */}
                        {t.source !== "supply_payment" && t.source !== "payout" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={deleting === t.id}
                            onClick={() => removeTx(t.id)}
                            aria-label="Удалить операцию"
                            title="Удалить ошибочную операцию"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AccountDialog open={accountDialog} onOpenChange={setAccountDialog} />
      <ReconcileDialog
        account={reconciling}
        open={reconciling != null}
        onOpenChange={(o) => !o && setReconciling(null)}
      />
      <EditAccountDialog
        account={editing}
        open={editing != null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  );
}
