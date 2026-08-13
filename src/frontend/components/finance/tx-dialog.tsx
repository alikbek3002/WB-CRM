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
import {
  BASE_CURRENCY,
  CURRENCY_CODES,
  CURRENCY_LABEL,
  CURRENCY_SIGN,
  rateToBase,
  type CurrencyRateMap,
} from "@/shared/currency";
import { formatRate, formatSom } from "@/shared/format";
import type { CashTxKind, Currency, ExpenseCategory } from "@/shared/types";

export type AccountOpt = { id: string; name: string; currency: Currency };
export type MemberOpt = { id: string; name: string; roleLabel: string };

const KIND_TITLE: Record<CashTxKind, string> = {
  out: "Новый расход",
  in: "Поступление денег",
  transfer: "Перевод между счетами",
};

// Пустая строка в Select значит «значение не выбрано» — для пункта
// «Не указывать» нужен отдельный маркер, иначе подпись не отображается.
const PERSON_NONE = "none";

const todayIso = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
};

// Одна форма на расход / приход / перевод.
//
// ВАЛЮТА. Деньги физически уходят со счёта, поэтому валюта операции = валюта
// счёта: выбор валюты сверху просто отбирает счета в ней (доллар, юань, сом…).
// Сумму вводят «как в жизни», а под полем сразу видно, сколько это в сомах —
// в базовой валюте считаются касса и прибыль.
export function TxDialog({
  open,
  onOpenChange,
  kind: initialKind,
  accounts,
  categories,
  members = [],
  rates,
  defaultCategoryId = "",
  defaultPersonId = "",
  lockKind = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: CashTxKind;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  members?: MemberOpt[];
  rates?: CurrencyRateMap; // курсы к сому из «Финансы → Валюты»
  defaultCategoryId?: string; // предзаполнение с экрана «Выплаты команде»
  defaultPersonId?: string;
  lockKind?: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<CashTxKind>(initialKind);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(accounts[1]?.id ?? "");
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [personId, setPersonId] = useState(defaultPersonId || PERSON_NONE);
  const [amount, setAmount] = useState("");
  const [amountTo, setAmountTo] = useState("");
  const [rate, setRate] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const [currency, setCurrency] = useState<Currency>(
    accounts[0]?.currency ?? BASE_CURRENCY,
  );

  const toAccount = accounts.find((a) => a.id === toAccountId);
  // Счёт — источник правды по валюте (её же проверит сервер); селект валюты
  // отбирает счета, а не переопределяет валюту операции.
  const accountsInCurrency = accounts.filter((a) => a.currency === currency);
  const noAccountInCurrency = accountsInCurrency.length === 0;
  const sign = CURRENCY_SIGN[currency];
  const needsRate = currency !== BASE_CURRENCY;
  const crossCurrency = kind === "transfer" && toAccount && toAccount.currency !== currency;

  // Курс: свой (курс сделки) важнее общего из «Валют»
  const rateNumber = Number(rate.replace(",", "."));
  const effectiveRate =
    Number.isFinite(rateNumber) && rateNumber > 0 ? rateNumber : rateToBase(currency, rates);
  const amountNumber = Number(amount.replace(/\s/g, "").replace(",", "."));
  const inBase =
    needsRate && Number.isFinite(amountNumber) && amountNumber > 0
      ? amountNumber * effectiveRate
      : null;

  function pickCurrency(next: Currency) {
    setCurrency(next);
    const first = accounts.find((a) => a.currency === next);
    setAccountId(first?.id ?? "");
    if (first && first.id === toAccountId) {
      setToAccountId(accounts.find((a) => a.id !== first.id)?.id ?? "");
    }
  }

  const options = useMemo(
    () => categories.filter((c) => c.direction === (kind === "in" ? "in" : "out")),
    [categories, kind],
  );

  // Зарплата, премия, гонорар подрядчику, возмещение — деньги конкретному
  // человеку. Для таких статей спрашиваем, кому именно: тогда сумма попадёт в
  // отчёт «Выплаты команде», а не растворится в общей строке расходов.
  const category = categories.find((c) => c.id === categoryId);
  const needsPerson = kind === "out" && Boolean(category?.isPayroll) && members.length > 0;

  function reset() {
    setAmount("");
    setAmountTo("");
    setNote("");
    setRate("");
    setCategoryId(defaultCategoryId);
    setPersonId(defaultPersonId || PERSON_NONE);
    setOccurredOn(todayIso());
  }

  async function submit() {
    const sum = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(sum) || sum <= 0) {
      toast.error("Укажите сумму");
      return;
    }
    if (!accountId) {
      toast.error(
        noAccountInCurrency
          ? `Нет счёта в ${sign} — создайте его в «Кассе»`
          : "Выберите счёт",
      );
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
          personId: needsPerson && personId !== PERSON_NONE ? personId : null,
          // Историческое имя поля: это курс к БАЗОВОЙ валюте (сому), см. 0043
          rateToRub:
            needsRate && Number.isFinite(rateNumber) && rateNumber > 0 ? rateNumber : null,
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

        <div className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0">
          {!lockKind && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Тип операции</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  if (!v) return;
                  const k = v as CashTxKind;
                  setKind(k);
                  // Статья другого направления не отображается в списке —
                  // сбрасываем, чтобы в кнопке не остался «сырой» uuid
                  const dir = k === "in" ? "in" : "out";
                  setCategoryId((prev) =>
                    prev && categories.some((c) => c.id === prev && c.direction === dir)
                      ? prev
                      : "",
                  );
                }}
              >
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
            <Label htmlFor="tx-amount">Сумма, {sign}</Label>
            <Input
              id="tx-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Например: 25000"
              autoFocus
            />
            {inBase != null && (
              <p className="text-[11px] text-muted-foreground">≈ {formatSom(inBase)}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>Валюта</Label>
            <Select value={currency} onValueChange={(v) => v && pickCurrency(v as Currency)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCY_CODES.map((c) => {
                  const has = accounts.some((a) => a.currency === c);
                  return (
                    <SelectItem key={c} value={c}>
                      {CURRENCY_LABEL[c]}
                      {has ? "" : " · нет счёта"}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {noAccountInCurrency && (
              <p className="text-[11px] text-amber-400">
                Счёта в {sign} нет. Завести его можно в «Кассе» — операция без счёта не
                запишется.
              </p>
            )}
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
            <Select
              value={accountId}
              onValueChange={(v) => {
                if (!v) return;
                setAccountId(v);
                // Счёт-получатель не может совпадать с источником
                if (v === toAccountId) {
                  setToAccountId(accounts.find((a) => a.id !== v)?.id ?? "");
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Выберите счёт" />
              </SelectTrigger>
              <SelectContent>
                {accountsInCurrency.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {CURRENCY_SIGN[a.currency]}
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
                        {a.name} · {CURRENCY_SIGN[a.currency]}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label>Статья {kind === "in" ? "прихода" : "расхода"}</Label>
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

          {needsPerson && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Кому выплата</Label>
              <Select value={personId} onValueChange={(v) => v && setPersonId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Выберите сотрудника" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PERSON_NONE}>Не указывать</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} · {m.roleLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Сумма попадёт в отчёт «Выплаты команде» — сколько получил каждый сотрудник.
                Для человека не из команды оставьте пустым и напишите имя в комментарии.
              </p>
            </div>
          )}

          {crossCurrency && (
            <div className="grid gap-1.5">
              <Label htmlFor="tx-amount-to">
                Зачислено, {CURRENCY_SIGN[toAccount?.currency ?? BASE_CURRENCY]}
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
              <Label htmlFor="tx-rate">Курс к сому</Label>
              <Input
                id="tx-rate"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder={formatRate(rateToBase(currency, rates))}
              />
              <p className="text-[11px] text-muted-foreground">
                Пусто — возьмём курс из «Валют»: 1 {sign} ={" "}
                {formatRate(rateToBase(currency, rates))} сом. Свой курс нужен, когда
                обменяли по другому.
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
          <Button onClick={submit} disabled={saving || accounts.length === 0 || !accountId}>
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
  members = [],
  rates,
  defaultCategoryId = "",
  defaultPersonId = "",
  label,
  lockKind = false,
  variant = "default",
}: {
  kind: CashTxKind;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  members?: MemberOpt[];
  rates?: CurrencyRateMap;
  defaultCategoryId?: string;
  defaultPersonId?: string;
  label: string;
  lockKind?: boolean;
  variant?: "default" | "outline" | "ghost";
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
        members={members}
        rates={rates}
        defaultCategoryId={defaultCategoryId}
        defaultPersonId={defaultPersonId}
        lockKind={lockKind}
      />
    </>
  );
}
