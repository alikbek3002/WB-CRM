"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Clock, Plus, Wallet, X } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
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
import { StatRow } from "@/frontend/components/finance/stat-row";
import { formatMoney, formatRub } from "@/shared/format";
import { cn } from "@/shared/utils";
import type {
  Currency,
  ExpenseCategory,
  PayoutKind,
  PayoutRequest,
  PayoutStatus,
  PayoutsView,
} from "@/shared/types";

type AccountOpt = { id: string; name: string; currency: Currency };
type FactoryOpt = { id: string; name: string };
type SupplyOpt = { id: string; title: string; factoryName: string };
type MemberOpt = { id: string; name: string; roleLabel: string };

// «Кому платим»: сотрудник из команды (тогда выплата попадёт в его карточку)
// или произвольное имя — подрядчик, фотограф, курьер.
const PAYEE_MANUAL = "__manual__";

const KIND_LABEL: Record<PayoutKind, string> = {
  salary: "Зарплата",
  contractor: "Подрядчик / услуги",
  factory: "Счёт фабрики",
  reimbursement: "Возмещение расходов",
  other: "Прочее",
};

const STATUS_META: Record<PayoutStatus, { label: string; className: string }> = {
  pending: { label: "Ждёт решения", className: "border-amber-500/40 text-amber-400" },
  approved: { label: "Согласовано", className: "border-sky-500/40 text-sky-400" },
  paid: { label: "Выплачено", className: "border-emerald-500/40 text-emerald-400" },
  rejected: { label: "Отклонено", className: "border-red-500/40 text-red-400" },
  cancelled: { label: "Отменено", className: "text-muted-foreground" },
};

const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ─── Запрос выплаты ──────────────────────────────────────────────────────────

function RequestDialog({
  open,
  onOpenChange,
  categories,
  factories,
  supplies,
  members,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  categories: ExpenseCategory[];
  factories: FactoryOpt[];
  supplies: SupplyOpt[];
  members: MemberOpt[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<PayoutKind>("contractor");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("rub");
  const [payeeUserId, setPayeeUserId] = useState("");
  const [payee, setPayee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [factoryId, setFactoryId] = useState("");
  const [supplyId, setSupplyId] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    const sum = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!title.trim()) {
      toast.error("Напишите, за что выплата");
      return;
    }
    if (!Number.isFinite(sum) || sum <= 0) {
      toast.error("Укажите сумму");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/payouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          amount: sum,
          currency,
          payee: payeeUserId && payeeUserId !== PAYEE_MANUAL ? null : payee.trim() || null,
          payeeUserId: payeeUserId && payeeUserId !== PAYEE_MANUAL ? payeeUserId : null,
          dueDate: dueDate || null,
          categoryId: categoryId || null,
          factoryId: kind === "factory" ? factoryId || null : null,
          supplyId: kind === "factory" ? supplyId || null : null,
          description: description.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(data?.message ?? "Заявка отправлена");
      setTitle("");
      setAmount("");
      setDescription("");
      setPayee("");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось отправить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Запросить выплату</DialogTitle>
          <DialogDescription>
            Руководитель получит заявку в Telegram сразу. После оплаты сумма спишется
            с выбранного счёта и попадёт в расходы — вносить второй раз не нужно.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0">
          <div className="grid gap-1.5">
            <Label>Тип выплаты</Label>
            <Select value={kind} onValueChange={(v) => v && setKind(v as PayoutKind)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABEL) as PayoutKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="p-amount">Сумма</Label>
            <div className="flex gap-2">
              <Input
                id="p-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Например: 45000"
              />
              <Select value={currency} onValueChange={(v) => v && setCurrency(v as Currency)}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rub">₽</SelectItem>
                  <SelectItem value="kgs">сом</SelectItem>
                  <SelectItem value="cny">¥</SelectItem>
                  <SelectItem value="uzs">сум</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="p-title">За что</Label>
            <Input
              id="p-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например: съёмка карточек, партия пижам, аванс за июль"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Кому платим</Label>
            <Select value={payeeUserId} onValueChange={(v) => setPayeeUserId(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Себе (заявителю)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Себе (заявителю)</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name} · {m.roleLabel}
                  </SelectItem>
                ))}
                <SelectItem value={PAYEE_MANUAL}>Другой человек или компания…</SelectItem>
              </SelectContent>
            </Select>
            {payeeUserId === PAYEE_MANUAL && (
              <Input
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder="Имя подрядчика или компания"
              />
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="p-due">Оплатить до</Label>
            <Input
              id="p-due"
              type="date"
              value={dueDate}
              min={todayIso()}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          {kind === "factory" ? (
            <>
              <div className="grid gap-1.5">
                <Label>Фабрика</Label>
                <Select value={factoryId} onValueChange={(v) => v && setFactoryId(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Выберите фабрику" />
                  </SelectTrigger>
                  <SelectContent>
                    {factories.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Поставка</Label>
                <Select value={supplyId} onValueChange={(v) => v && setSupplyId(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="К какой поставке" />
                  </SelectTrigger>
                  <SelectContent>
                    {supplies.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title} · {s.factoryName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  После оплаты сумма зачтётся как оплата этой поставки
                </p>
              </div>
            </>
          ) : (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Статья расхода</Label>
              <Select value={categoryId} onValueChange={(v) => v && setCategoryId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Подберётся автоматически, если не выбрать" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.emoji ? `${c.emoji} ` : ""}
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="p-desc">Комментарий</Label>
            <Input
              id="p-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Номер счёта, реквизиты, детали работы"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Отправка…" : "Отправить заявку"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Оплата заявки ───────────────────────────────────────────────────────────

function PayDialog({
  payout,
  accounts,
  onOpenChange,
}: {
  payout: PayoutRequest | null;
  accounts: AccountOpt[];
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  // Счёт в валюте заявки — иначе сумма спишется не в той валюте
  const matching = accounts.filter((a) => a.currency === payout?.currency);
  const [accountId, setAccountId] = useState(matching[0]?.id ?? accounts[0]?.id ?? "");
  const [paidOn, setPaidOn] = useState(todayIso());
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!payout || !accountId) {
      toast.error("Выберите счёт");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/payouts/${payout.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pay", accountId, paidOn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Ошибка");
      toast.success(data?.message ?? "Выплата проведена");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось оплатить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(payout)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Оплатить заявку</DialogTitle>
          <DialogDescription>
            {payout
              ? `«${payout.title}» — ${formatMoney(payout.amount, payout.currency)}. Сумма спишется со счёта и попадёт в расходы.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0">
          <div className="grid gap-1.5">
            <Label>Счёт списания</Label>
            <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Выберите счёт" />
              </SelectTrigger>
              <SelectContent>
                {(matching.length ? matching : accounts).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {a.currency === "rub" ? "₽" : a.currency === "cny" ? "¥" : a.currency === "kgs" ? "сом" : "сум"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {payout && !matching.length && (
              <p className="text-[11px] text-amber-400">
                Нет счёта в валюте заявки — сумма спишется как есть, проверьте валюту
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-date">Дата оплаты</Label>
            <Input
              id="pay-date"
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Оплата…" : "Оплатить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Список ──────────────────────────────────────────────────────────────────

export function PayoutsBoard({
  view,
  canApprove,
  currentUserId,
  accounts,
  categories,
  factories,
  supplies,
  members = [],
}: {
  view: PayoutsView;
  canApprove: boolean;
  currentUserId: string;
  accounts: AccountOpt[];
  categories: ExpenseCategory[];
  factories: FactoryOpt[];
  supplies: SupplyOpt[];
  members?: MemberOpt[];
}) {
  const router = useRouter();
  const [requestOpen, setRequestOpen] = useState(false);
  const [paying, setPaying] = useState<PayoutRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "reject" | "cancel", note?: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/payouts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Ошибка");
      toast.success(data?.message ?? "Готово");
      router.refresh();
    } catch (e) {
      toast.error(`Не получилось: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const waiting = view.items.filter((i) => i.status === "pending" || i.status === "approved");
  const history = view.items.filter((i) => !waiting.includes(i));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {canApprove
            ? "Согласованные заявки ждут оплаты — деньги спишутся со счёта кассы"
            : "Здесь ваши заявки и их статус"}
        </div>
        <Button size="sm" onClick={() => setRequestOpen(true)}>
          <Plus className="size-4" />
          Запросить выплату
        </Button>
      </div>

      <StatRow
        stats={[
          {
            label: "Ждут решения",
            value: String(view.pendingCount),
            hint: view.pendingRub > 0 ? `на ${formatRub(view.pendingRub)}` : undefined,
            tone: view.pendingCount > 0 ? "bad" : "default",
          },
          {
            label: "Согласовано к оплате",
            value: formatRub(view.approvedRub),
            hint: "ещё не выплачено",
          },
          {
            label: "Выплачено за месяц",
            value: formatRub(view.paidMonthRub),
          },
          {
            label: "Всего заявок",
            value: String(view.items.length),
            tone: "muted",
          },
        ]}
      />

      {waiting.length === 0 && history.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Заявок пока нет. Нажмите «Запросить выплату» — или напишите боту в Telegram:
            <br />
            <span className="text-foreground">«нужно оплатить фотографу 15 тысяч»</span>
          </CardContent>
        </Card>
      )}

      {waiting.map((p) => (
        <Card key={p.id}>
          <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.title}</span>
                <Badge variant="outline" className={cn("text-[11px]", STATUS_META[p.status].className)}>
                  {STATUS_META[p.status].label}
                </Badge>
                <span className="text-xs text-muted-foreground">{KIND_LABEL[p.kind]}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {p.requesterName}
                {p.requesterRole ? ` · ${p.requesterRole}` : ""} · {dmy(p.createdAt)}
                {p.payee ? ` · кому: ${p.payee}` : ""}
                {p.dueDate ? ` · до ${dmy(p.dueDate)}` : ""}
                {p.supplyTitle ? ` · поставка «${p.supplyTitle}»` : ""}
                {p.factoryName && !p.supplyTitle ? ` · фабрика ${p.factoryName}` : ""}
              </div>
              {p.description && (
                <div className="text-xs text-muted-foreground">{p.description}</div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="font-semibold tabular-nums">
                  {formatMoney(p.amount, p.currency)}
                </div>
                {p.currency !== "rub" && (
                  <div className="text-[11px] text-muted-foreground">≈ {formatRub(p.amountRub)}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {canApprove && p.status === "pending" && (
                  <>
                    <Button size="sm" disabled={busy === p.id} onClick={() => act(p.id, "approve")}>
                      <Check className="size-4" />
                      Согласовать
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === p.id}
                      onClick={() => act(p.id, "reject")}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                )}
                {canApprove && p.status === "approved" && (
                  <Button size="sm" disabled={busy === p.id} onClick={() => setPaying(p)}>
                    <Wallet className="size-4" />
                    Оплатить
                  </Button>
                )}
                {!canApprove && p.requesterId === currentUserId && p.status === "pending" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === p.id}
                    onClick={() => act(p.id, "cancel")}
                  >
                    Отменить
                  </Button>
                )}
                {!canApprove && p.status === "approved" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3.5" />
                    ждёт оплаты
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {history.length > 0 && (
        <Card className="py-0">
          <CardContent className="divide-y divide-border/60 px-4 py-0">
            {history.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cn(p.status === "paid" ? "" : "text-muted-foreground")}>
                      {p.title}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn("text-[11px]", STATUS_META[p.status].className)}
                    >
                      {STATUS_META[p.status].label}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {p.requesterName} · {dmy(p.createdAt)}
                    {p.paidAt ? ` · оплачено ${dmy(p.paidAt)}` : ""}
                    {p.paidAccountName ? ` · ${p.paidAccountName}` : ""}
                    {p.decisionNote ? ` · ${p.decisionNote}` : ""}
                  </div>
                </div>
                <div className="text-right text-sm tabular-nums">
                  {formatMoney(p.amount, p.currency)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <RequestDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        categories={categories}
        factories={factories}
        supplies={supplies}
        members={members}
      />
      <PayDialog payout={paying} accounts={accounts} onOpenChange={() => setPaying(null)} />
    </div>
  );
}
