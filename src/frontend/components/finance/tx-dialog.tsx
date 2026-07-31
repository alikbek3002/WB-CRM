"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
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
import { EXCHANGE_RATES } from "@/shared/constants";
import { formatMoney } from "@/shared/format";
import type { CashTxKind, Currency, ExpenseCategory } from "@/shared/types";

export type AccountOpt = { id: string; name: string; currency: Currency };

const KIND_TITLE: Record<CashTxKind, string> = {
  out: "Новый расход",
  in: "Поступление денег",
  transfer: "Перевод между счетами",
};

const todayIso = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
};

// Одна форма на расход / приход / перевод: валюту и курс подставляет счёт,
// поэтому пользователь вводит только сумму «как в жизни».
export function TxDialog({
  open,
  onOpenChange,
  kind: initialKind,
  accounts,
  categories,
  lockKind = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: CashTxKind;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  lockKind?: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<CashTxKind>(initialKind);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(accounts[1]?.id ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [amountTo, setAmountTo] = useState("");
  const [rate, setRate] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const account = accounts.find((a) => a.id === accountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);
  const currency = account?.currency ?? "rub";
  const needsRate = currency !== "rub";
  const crossCurrency = kind === "transfer" && toAccount && toAccount.currency !== currency;

  const options = useMemo(
    () => categories.filter((c) => c.direction === (kind === "in" ? "in" : "out")),
    [categories, kind],
  );

  function reset() {
    setAmount("");
    setAmountTo("");
    setNote("");
    setRate("");
    setCategoryId("");
    setOccurredOn(todayIso());
  }

  async function submit() {
    const sum = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(sum) || sum <= 0) {
      toast.error("Укажите сумму");
      return;
    }
    if (!accountId) {
      toast.error("Выберите счёт");
      return;
    }
    if (kind !== "transfer" && !categoryId) {
      toast.error("Выберите статью");
      return;
    }
    if (kind === "transfer" && (!toAccountId || toAccountId === accountId)) {
      toast.error("Выберите второй счёт для перевода");
      return;
    }
    const toSum = Number(amountTo.replace(/\s/g, "").replace(",", "."));
    if (crossCurrency && (!Number.isFinite(toSum) || toSum <= 0)) {
      toast.error("Счета в разных валютах — укажите сумму зачисления");
      return;
    }
    const rateNum = Number(rate.replace(",", "."));

    setSaving(true);
    try {
      const res = await fetch("/api/finance/cash/tx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          accountId,
          toAccountId: kind === "transfer" ? toAccountId : null,
          categoryId: kind === "transfer" ? null : categoryId,
          amount: sum,
          amountTo: crossCurrency ? toSum : null,
          occurredOn,
          note: note.trim() || null,
          rateToRub: needsRate && Number.isFinite(rateNum) && rateNum > 0 ? rateNum : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(data?.message ?? "Операция записана");
      reset();
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось записать: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{KIND_TITLE[kind]}</DialogTitle>
          <DialogDescription>
            {kind === "out"
              ? "Расход уменьшит остаток на счёте и попадёт в прибыль (кроме закупа товара и выплат владельцу)."
              : kind === "in"
                ? "Поступление увеличит остаток на счёте. Деньги от WB прибылью не считаются — она уже учтена по продажам."
                : "Перевод не меняет общую сумму денег, только распределение между счетами."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          {!lockKind && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Тип операции</Label>
              <Select value={kind} onValueChange={(v) => v && setKind(v as CashTxKind)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="out">Расход</SelectItem>
                  <SelectItem value="in">Поступление</SelectItem>
                  <SelectItem value="transfer">Перевод между счетами</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="tx-amount">Сумма{currency !== "rub" ? `, ${currency === "cny" ? "¥" : "сум"}` : ", ₽"}</Label>
            <Input
              id="tx-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Например: 25000"
              autoFocus
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tx-date">Дата</Label>
            <Input
              id="tx-date"
              type="date"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>{kind === "transfer" ? "Списать со счёта" : "Счёт"}</Label>
            <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Выберите счёт" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.currency !== "rub" ? ` · ${a.currency === "cny" ? "¥" : "сум"}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {kind === "transfer" ? (
            <div className="grid gap-1.5">
              <Label>Зачислить на счёт</Label>
              <Select value={toAccountId} onValueChange={(v) => v && setToAccountId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Выберите счёт" />
                </SelectTrigger>
                <SelectContent>
                  {accounts
                    .filter((a) => a.id !== accountId)
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.currency !== "rub" ? ` · ${a.currency === "cny" ? "¥" : "сум"}` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label>Статья</Label>
              <Select value={categoryId} onValueChange={(v) => v && setCategoryId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Выберите статью" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.emoji ? `${c.emoji} ` : ""}
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {crossCurrency && (
            <div className="grid gap-1.5">
              <Label htmlFor="tx-amount-to">
                Зачислено, {toAccount?.currency === "cny" ? "¥" : toAccount?.currency === "uzs" ? "сум" : "₽"}
              </Label>
              <Input
                id="tx-amount-to"
                inputMode="decimal"
                value={amountTo}
                onChange={(e) => setAmountTo(e.target.value)}
                placeholder="Сколько пришло на второй счёт"
              />
            </div>
          )}

          {needsRate && (
            <div className="grid gap-1.5">
              <Label htmlFor="tx-rate">Курс к рублю</Label>
              <Input
                id="tx-rate"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder={String(EXCHANGE_RATES[currency] ?? 1)}
              />
              <p className="text-[11px] text-muted-foreground">
                Пусто — возьмём общий курс ({formatMoney(1, currency)} ≈{" "}
                {EXCHANGE_RATES[currency] ?? 1} ₽)
              </p>
            </div>
          )}

          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="tx-note">Комментарий</Label>
            <Input
              id="tx-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Например: реклама за неделю, кампания «Пижамы»"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving || accounts.length === 0}>
            {saving ? "Сохранение…" : "Записать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Кнопка + диалог одним куском — чтобы страницы не тащили состояние
export function AddTxButton({
  kind,
  accounts,
  categories,
  label,
  lockKind = false,
  variant = "default",
}: {
  kind: CashTxKind;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  label: string;
  lockKind?: boolean;
  variant?: "default" | "outline";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {label}
      </Button>
      <TxDialog
        open={open}
        onOpenChange={setOpen}
        kind={kind}
        accounts={accounts}
        categories={categories}
        lockKind={lockKind}
      />
    </>
  );
}
