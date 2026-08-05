"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/frontend/components/ui/tabs";
import { toRub } from "@/shared/constants";
import { formatMoney, formatNumber, formatRub } from "@/shared/format";
import type { Currency, Supply, SupplyStatus } from "@/shared/types";

type FactoryOpt = { id: string; name: string; country: "china" | "uzbekistan" };
type ProductOpt = { id: string; title: string };
type PartnerOpt = { id: string; name: string; ratePerUnitRub: number };

// Черновик позиции в форме создания поставки (строки — потому что это поля ввода)
type ItemDraft = {
  productId: string; // "none" — без привязки к карточке WB
  title: string;
  quantity: string;
  sewingCost: string;
  sewingCurrency: Currency;
};

const emptyItem = (cur: Currency): ItemDraft => ({
  productId: "none",
  title: "",
  quantity: "",
  sewingCost: "",
  sewingCurrency: cur,
});

const CURRENCY_LABEL: Record<Currency, string> = {
  cny: "¥ юань",
  uzs: "сум",
  rub: "₽ рубль",
  kgs: "сом", // валюта кабинета WB (киргизское юрлицо)
};

const STATUS_ORDER: (SupplyStatus | "all")[] = [
  "all",
  "in_transit",
  "arrived",
  "received",
  "sorting",
  "in_stock",
  "distributed",
];

const STATUS_FILTER_LABEL: Record<SupplyStatus | "all", string> = {
  all: "Все",
  in_transit: "В пути",
  arrived: "Приехал",
  received: "Принят",
  sorting: "В разборе",
  in_stock: "Лежит",
  distributed: "Распределён",
  cancelled: "Отменён",
};

function statusBadgeClass(status: SupplyStatus): string {
  switch (status) {
    case "in_transit":
      return "border-amber-500/50 text-amber-400";
    case "arrived":
      return "border-violet-500/50 text-violet-300";
    case "received":
      return "border-sky-500/50 text-sky-300";
    case "sorting":
      return "border-amber-500/50 text-amber-400";
    case "in_stock":
      return "border-sky-500/50 text-sky-300";
    case "distributed":
      return "border-emerald-500/50 text-emerald-400";
    default:
      return "border-border text-muted-foreground";
  }
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function SuppliesBoard({
  supplies,
  factories,
  products,
  partners,
  canEdit,
  canPay,
  canReceive,
}: {
  supplies: Supply[];
  factories: FactoryOpt[];
  products: ProductOpt[];
  partners: PartnerOpt[];
  canEdit: boolean;
  canPay: boolean;
  canReceive: boolean;
}) {
  const [filter, setFilter] = useState<SupplyStatus | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const visible = useMemo(
    () => (filter === "all" ? supplies : supplies.filter((s) => s.status === filter)),
    [supplies, filter],
  );
  const detail = detailId ? supplies.find((s) => s.id === detailId) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_ORDER.map((s) => (
          <Button
            key={s}
            size="xs"
            variant={filter === s ? "default" : "outline"}
            onClick={() => setFilter(s)}
          >
            {STATUS_FILTER_LABEL[s]}
          </Button>
        ))}
        {canEdit && (
          <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Создать поставку
          </Button>
        )}
      </div>

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Товар</TableHead>
                <TableHead>Фабрика</TableHead>
                <TableHead className="text-right">Кол-во</TableHead>
                <TableHead>Отгружено</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">В пути</TableHead>
                <TableHead className="text-right">Долг, ₽</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.title}</TableCell>
                  <TableCell className="text-muted-foreground">{s.factoryName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(s.quantity)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{s.shipDate}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] ${statusBadgeClass(s.status)}`}>
                      {s.statusLabel}
                      {s.autoArrived && " · авто"}
                    </Badge>
                    {s.shortage > 0 && (
                      <Badge variant="outline" className="ml-1 border-red-500/50 text-[10px] text-red-400">
                        −{s.shortage}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.daysInTransit != null ? `${s.daysInTransit} дн` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.owedRub > 0 ? (
                      <span className="text-amber-400">{formatRub(s.owedRub)}</span>
                    ) : (
                      <span className="text-emerald-400">оплачено</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="xs" variant="ghost" onClick={() => setDetailId(s.id)}>
                      Детали
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    Поставок в этом статусе нет.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canEdit && (
        <CreateSupplyDialog
          partners={partners}
          open={createOpen}
          onOpenChange={setCreateOpen}
          factories={factories}
          products={products}
        />
      )}

      <SupplyDetailDialog
        supply={detail}
        onClose={() => setDetailId(null)}
        canPay={canPay}
        canReceive={canReceive}
      />
    </div>
  );
}

// ─── Создание поставки ────────────────────────────────────────────────────────

function CreateSupplyDialog({
  open,
  onOpenChange,
  factories,
  products,
  partners,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factories: FactoryOpt[];
  products: ProductOpt[];
  partners: PartnerOpt[];
}) {
  const router = useRouter();
  const [factoryId, setFactoryId] = useState(factories[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [shipDate, setShipDate] = useState(todayIso());
  const [items, setItems] = useState<ItemDraft[]>([emptyItem("cny")]);
  const [cargoCost, setCargoCost] = useState("");
  const [cargoCurrency, setCargoCurrency] = useState<Currency>("cny");
  const [partnerId, setPartnerId] = useState("none");
  const [saving, setSaving] = useState(false);

  function pickFactory(id: string) {
    setFactoryId(id);
    const f = factories.find((x) => x.id === id);
    const cur: Currency = f?.country === "uzbekistan" ? "uzs" : "cny";
    setCargoCurrency(cur);
    setItems((prev) => prev.map((i) => ({ ...i, sewingCurrency: cur })));
  }

  const patchItem = (idx: number, patch: Partial<ItemDraft>) =>
    setItems((prev) => prev.map((i, n) => (n === idx ? { ...i, ...patch } : i)));

  function pickItemProduct(idx: number, id: string) {
    const p = products.find((x) => x.id === id);
    // Наименование подставляем из карточки, если его ещё не вводили руками
    patchItem(idx, {
      productId: id,
      title: !items[idx].title.trim() && p ? p.title : items[idx].title,
    });
  }

  // Предпросчёт себестоимости единицы — та же формула, что и на приёмке
  // (backend/data/cost-core.ts): карго и услуги ФФ делятся между позициями
  // пропорционально количеству.
  const totalQty = items.reduce((t, i) => t + (Number(i.quantity) || 0), 0);
  const partner = partners.find((p) => p.id === partnerId) ?? null;
  const cargoRub = toRub(Number(cargoCost) || 0, cargoCurrency);
  const ffRub = partner ? partner.ratePerUnitRub * totalQty : 0;
  const perUnitShared = totalQty > 0 ? (cargoRub + ffRub) / totalQty : 0;

  async function submit() {
    if (!factoryId) return toast.error("Выберите фабрику");
    const filled = items.filter((i) => i.title.trim() || Number(i.quantity) > 0);
    if (filled.length === 0) return toast.error("Добавьте хотя бы одну позицию");
    if (filled.some((i) => !i.title.trim())) {
      return toast.error("У каждой позиции должно быть наименование");
    }

    setSaving(true);
    try {
      const headTitle =
        title.trim() ||
        (filled.length === 1
          ? filled[0].title.trim()
          : `${filled[0].title.trim()} и ещё ${filled.length - 1}`);

      const res = await fetch("/api/supplies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          factoryId,
          title: headTitle,
          quantity: totalQty,
          shipDate,
          // Отшив теперь живёт на позициях; в шапке оставляем нули
          sewingCost: 0,
          sewingCurrency: items[0]?.sewingCurrency ?? "cny",
          cargoCost: Number(cargoCost) || 0,
          cargoCurrency,
          fulfillmentPartnerId: partnerId === "none" ? null : partnerId,
          items: filled.map((i) => ({
            productId: i.productId === "none" ? null : i.productId,
            title: i.title.trim(),
            quantity: Number(i.quantity) || 0,
            sewingCost: Number(i.sewingCost) || 0,
            sewingCurrency: i.sewingCurrency,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(
        data.persisted
          ? `Поставка «${headTitle}» создана — ${filled.length} поз., статус «В пути»`
          : `Поставка принята (демо — без записи в БД)`,
      );
      setTitle("");
      setItems([emptyItem(cargoCurrency)]);
      setCargoCost("");
      setPartnerId("none");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось создать поставку: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Новая поставка</DialogTitle>
          <DialogDescription>
            Одно карго может везти несколько артикулов. Отшив указывается по каждой
            позиции, а карго и услуги фул-фирмы делятся между ними пропорционально
            количеству — из этого складывается себестоимость единицы.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Фабрика</Label>
            <Select value={factoryId} onValueChange={(v) => v && pickFactory(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Выберите фабрику" />
              </SelectTrigger>
              <SelectContent>
                {factories.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name} · {f.country === "china" ? "Китай" : "Узбекистан"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {factories.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Фабрик пока нет — сначала добавьте на странице «Фабрики».
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sup-ship">Дата отгрузки</Label>
            <Input
              id="sup-ship"
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
            />
          </div>

          {/* Позиции: в одном карго обычно едет несколько артикулов. Отшив у
              каждого свой, карго и услуги фул-фирмы делятся между ними. */}
          <div className="space-y-2 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">
                Что везём · {items.length} поз. · {formatNumber(totalQty)} шт
              </Label>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setItems((p) => [...p, emptyItem(cargoCurrency)])}
              >
                <Plus className="size-3.5" />
                Позиция
              </Button>
            </div>

            {items.map((item, idx) => {
              const qty = Number(item.quantity) || 0;
              const sewingPerUnit = qty > 0 ? toRub(Number(item.sewingCost) || 0, item.sewingCurrency) / qty : 0;
              return (
                <div key={idx} className="space-y-1.5 rounded-md bg-muted/20 p-2">
                  <div className="flex items-center gap-2">
                    <Select
                      value={item.productId}
                      onValueChange={(v) => v && pickItemProduct(idx, String(v))}
                    >
                      <SelectTrigger className="h-8 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Без привязки к WB</SelectItem>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {items.length > 1 && (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Убрать позицию"
                        onClick={() => setItems((p) => p.filter((_, n) => n !== idx))}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>

                  <Input
                    value={item.title}
                    onChange={(e) => patchItem(idx, { title: e.target.value })}
                    placeholder="Наименование позиции"
                    className="h-8"
                  />

                  <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                    <Input
                      type="number"
                      min={0}
                      value={item.quantity}
                      onChange={(e) => patchItem(idx, { quantity: e.target.value })}
                      placeholder="шт"
                      className="h-8"
                    />
                    <div className="flex gap-1">
                      <Input
                        type="number"
                        min={0}
                        value={item.sewingCost}
                        onChange={(e) => patchItem(idx, { sewingCost: e.target.value })}
                        placeholder="отшив за партию"
                        className="h-8"
                      />
                      <Select
                        value={item.sewingCurrency}
                        onValueChange={(v) => v && patchItem(idx, { sewingCurrency: v as Currency })}
                      >
                        <SelectTrigger className="h-8 w-20">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cny">¥</SelectItem>
                          <SelectItem value="uzs">сум</SelectItem>
                          <SelectItem value="rub">₽</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {qty > 0 && (
                    <div className="text-[10px] leading-tight text-muted-foreground">
                      себестоимость ≈ {formatRub(Math.round(sewingPerUnit + perUnitShared))}/шт
                      {perUnitShared > 0 &&
                        ` (отшив ${formatRub(Math.round(sewingPerUnit))} + карго и ФФ ${formatRub(Math.round(perUnitShared))})`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <CostRow
            label="Карго на всю поставку"
            cost={cargoCost}
            onCost={setCargoCost}
            currency={cargoCurrency}
            onCurrency={setCargoCurrency}
          />

          <div className="grid gap-1.5">
            <Label>Фул-фирма (разбор и упаковка)</Label>
            <Select value={partnerId} onValueChange={(v) => v && setPartnerId(String(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Не привлекаем</SelectItem>
                {partners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {formatRub(p.ratePerUnitRub)}/шт
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {partner && totalQty > 0 && (
              <p className="text-xs text-muted-foreground">
                Начислим {formatRub(ffRub)} за {formatNumber(totalQty)} шт — войдёт в себестоимость.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sup-title">Название поставки (необязательно)</Label>
            <Input
              id="sup-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например, Карго из Гуанчжоу, июль"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Сохранение…" : "Создать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CostRow({
  label,
  cost,
  onCost,
  currency,
  onCurrency,
}: {
  label: string;
  cost: string;
  onCost: (v: string) => void;
  currency: Currency;
  onCurrency: (v: Currency) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          type="number"
          min={0}
          value={cost}
          onChange={(e) => onCost(e.target.value)}
          placeholder="Сумма"
          className="flex-1"
        />
        <Select value={currency} onValueChange={(v) => onCurrency(v as Currency)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CURRENCY_LABEL) as Currency[]).map((c) => (
              <SelectItem key={c} value={c}>
                {CURRENCY_LABEL[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ─── Деталь поставки (вкладки: Обзор · Финансы · Приёмка · Распределение) ──────

function SupplyDetailDialog({
  supply,
  onClose,
  canPay,
  canReceive,
}: {
  supply: Supply | null;
  onClose: () => void;
  canPay: boolean;
  canReceive: boolean;
}) {
  return (
    <Dialog open={supply != null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {supply && (
          <>
            <DialogHeader>
              <DialogTitle>{supply.title}</DialogTitle>
              <DialogDescription>
                {supply.factoryName} · {supply.statusLabel}
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="overview">
              <TabsList className="w-full">
                <TabsTrigger value="overview">Обзор</TabsTrigger>
                <TabsTrigger value="finance">Финансы</TabsTrigger>
                <TabsTrigger value="receipt">Приёмка</TabsTrigger>
                <TabsTrigger value="distribute">Склады WB</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="pt-3">
                <OverviewTab supply={supply} />
              </TabsContent>
              <TabsContent value="finance" className="pt-3">
                <FinanceTab supply={supply} canPay={canPay} />
              </TabsContent>
              <TabsContent value="receipt" className="pt-3">
                <ReceiptTab supply={supply} canReceive={canReceive} />
              </TabsContent>
              <TabsContent value="distribute" className="pt-3">
                <DistributeTab supply={supply} canReceive={canReceive} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

function OverviewTab({ supply }: { supply: Supply }) {
  return (
    <div className="divide-y divide-border/60">
      <Row label="Количество" value={`${formatNumber(supply.quantity)} шт`} />
      <Row label="Дата отгрузки" value={supply.shipDate} />
      <Row
        label="Отшивка"
        value={formatMoney(supply.sewingCost, supply.sewingCurrency)}
      />
      <Row label="Карго" value={formatMoney(supply.cargoCost, supply.cargoCurrency)} />
      {supply.fulfillmentPartnerName && (
        <Row
          label={`Фул-фирма · ${supply.fulfillmentPartnerName}`}
          value={formatRub(supply.fulfillmentRub)}
        />
      )}
      <Row label="В пути" value={supply.daysInTransit != null ? `${supply.daysInTransit} дн` : "—"} />

      {/* Позиции с себестоимостью единицы: карго и услуги ФФ уже разнесены
          между ними пропорционально количеству. */}
      {supply.items.length > 0 && (
        <div className="py-2">
          <div className="mb-1.5 text-sm text-muted-foreground">
            Позиции · {supply.items.length}
          </div>
          <div className="space-y-1.5">
            {supply.items.map((i) => (
              <div key={i.id} className="rounded-md bg-muted/20 px-2.5 py-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate font-medium">{i.title}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatNumber(i.receivedQty ?? i.quantity)} шт
                  </span>
                </div>
                <div className="text-[11px] leading-tight text-muted-foreground">
                  {formatRub(i.unitCostRub)}/шт = отшив {formatRub(i.sewingRub)} + карго{" "}
                  {formatRub(i.cargoRub)}
                  {i.fulfillmentRub > 0 && ` + фул-фирма ${formatRub(i.fulfillmentRub)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {supply.receivedQty != null && (
        <Row label="Принято" value={`${formatNumber(supply.receivedQty)} шт`} />
      )}
      {supply.shortage > 0 && (
        <div className="flex items-center justify-between gap-2 py-1 text-sm">
          <span className="text-muted-foreground">Недостача</span>
          <span className="tabular-nums font-medium text-red-400">−{supply.shortage} шт</span>
        </div>
      )}
      {supply.receiptComment && (
        <div className="py-2 text-sm">
          <div className="text-muted-foreground">Комментарий приёмки</div>
          <div className="mt-0.5">{supply.receiptComment}</div>
        </div>
      )}
      <Row label="Ответственный" value={supply.responsible} />
    </div>
  );
}

function FinanceTab({ supply, canPay }: { supply: Supply; canPay: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<"goods" | "cargo" | "fulfillment">("goods");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(supply.sewingCurrency);
  const [paidAt, setPaidAt] = useState(todayIso());
  const [saving, setSaving] = useState(false);

  async function pay() {
    if (!(Number(amount) > 0)) return toast.error("Укажите сумму оплаты");
    setSaving(true);
    try {
      const res = await fetch(`/api/supplies/${supply.id}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, amount: Number(amount), currency, paidAt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(data.persisted ? "Оплата зафиксирована" : "Оплата принята (демо)");
      setAmount("");
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось записать оплату: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="divide-y divide-border/60">
        <Row label="Оплачено за товар" value={formatRub(supply.paidGoodsRub)} />
        <Row label="Оплачено за карго" value={formatRub(supply.paidCargoRub)} />
        {(supply.fulfillmentRub > 0 || supply.paidFulfillmentRub > 0) && (
          <Row label="Оплачено фул-фирме" value={formatRub(supply.paidFulfillmentRub)} />
        )}
        <div className="flex items-center justify-between gap-2 py-1 text-sm">
          <span className="text-muted-foreground">Остаток долга</span>
          <span className={`tabular-nums font-medium ${supply.owedRub > 0 ? "text-amber-400" : "text-emerald-400"}`}>
            {supply.owedRub > 0 ? formatRub(supply.owedRub) : "нет"}
          </span>
        </div>
      </div>

      {supply.payments.length > 0 && (
        <div className="rounded-lg border border-border/60">
          {supply.payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5 text-sm last:border-0">
              <span className="text-muted-foreground">
                {p.kind === "goods" ? "Товар" : p.kind === "cargo" ? "Карго" : "Фул-фирма"} · {p.paidAt}
              </span>
              <span className="tabular-nums">{formatMoney(p.amount, p.currency)}</span>
            </div>
          ))}
        </div>
      )}

      {canPay && (
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="text-xs font-medium text-muted-foreground">Добавить оплату</div>
          <div className="flex gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as "goods" | "cargo" | "fulfillment")}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="goods">Товар</SelectItem>
                <SelectItem value="cargo">Карго</SelectItem>
                <SelectItem value="fulfillment">Фул-фирма</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Сумма"
              className="flex-1"
            />
            <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CURRENCY_LABEL) as Currency[]).map((c) => (
                  <SelectItem key={c} value={c}>
                    {CURRENCY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="flex-1" />
            <Button size="sm" onClick={pay} disabled={saving}>
              {saving ? "…" : "Оплатить"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReceiptTab({ supply, canReceive }: { supply: Supply; canReceive: boolean }) {
  const router = useRouter();
  const alreadyReceived = supply.receivedAt != null;
  const [qty, setQty] = useState(String(supply.quantity));
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  async function receive() {
    if (!comment.trim()) return toast.error("Комментарий обязателен (весь товар / недостача)");
    setSaving(true);
    try {
      const res = await fetch(`/api/supplies/${supply.id}/receive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receivedQty: Number(qty) || 0, receiptComment: comment.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(data.persisted ? "Товар принят — время в пути посчитано" : "Приёмка принята (демо)");
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось подтвердить приёмку: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (alreadyReceived) {
    return (
      <div className="divide-y divide-border/60">
        <Row label="Принято" value={`${formatNumber(supply.receivedQty ?? 0)} из ${formatNumber(supply.quantity)} шт`} />
        <Row label="Время в пути" value={supply.transitDays != null ? `${supply.transitDays} дн` : "—"} />
        {supply.shortage > 0 && (
          <div className="flex items-center justify-between gap-2 py-1 text-sm">
            <span className="text-muted-foreground">Недостача</span>
            <span className="tabular-nums font-medium text-red-400">−{supply.shortage} шт</span>
          </div>
        )}
        {supply.receiptComment && (
          <div className="py-2 text-sm">
            <div className="text-muted-foreground">Комментарий</div>
            <div className="mt-0.5">{supply.receiptComment}</div>
          </div>
        )}
      </div>
    );
  }

  if (!canReceive) {
    return <p className="text-sm text-muted-foreground">Приёмку подтверждает менеджер приёмки в Москве.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Подтвердите прибытие. Комментарий обязателен: пришёл весь товар или с недостачей.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="rcv-qty">Фактически принято, шт</Label>
        <Input id="rcv-qty" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="rcv-comment">Комментарий приёмки</Label>
        <Input
          id="rcv-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Пришёл весь товар / недостача 10 шт — брак"
        />
      </div>
      <Button
        onClick={receive}
        disabled={saving}
        className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
      >
        {saving ? "Сохранение…" : "✓ Товар прибыл"}
      </Button>
    </div>
  );
}

function DistributeTab({ supply, canReceive }: { supply: Supply; canReceive: boolean }) {
  const router = useRouter();
  const [warehouse, setWarehouse] = useState("");
  const [qty, setQty] = useState("");
  const [saving, setSaving] = useState(false);
  const received = supply.receivedAt != null;
  const remaining = (supply.receivedQty ?? supply.quantity) - supply.distributedQty;

  async function distribute() {
    if (!warehouse.trim()) return toast.error("Укажите склад WB");
    if (!(Number(qty) > 0)) return toast.error("Укажите количество");
    setSaving(true);
    try {
      const res = await fetch(`/api/supplies/${supply.id}/distribute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warehouse: warehouse.trim(), quantity: Number(qty) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(data.persisted ? `Отправлено на «${warehouse.trim()}»` : "Распределение принято (демо)");
      setWarehouse("");
      setQty("");
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось распределить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {supply.distributions.length > 0 ? (
        <div className="rounded-lg border border-border/60">
          {supply.distributions.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5 text-sm last:border-0">
              <span className="text-muted-foreground">{d.warehouse}</span>
              <span className="tabular-nums">{formatNumber(d.quantity)} шт</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm font-medium">
            <span>Итого распределено</span>
            <span className="tabular-nums">{formatNumber(supply.distributedQty)} шт</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Ещё не распределено по складам.</p>
      )}

      {canReceive && received && (
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="text-xs font-medium text-muted-foreground">
            Отправить на склад WB · остаток {formatNumber(Math.max(0, remaining))} шт
          </div>
          <div className="flex gap-2">
            <Input
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              placeholder="Коледино"
              className="flex-1"
            />
            <Input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Кол-во"
              className="w-28"
            />
            <Button size="sm" onClick={distribute} disabled={saving}>
              {saving ? "…" : "OK"}
            </Button>
          </div>
        </div>
      )}
      {!received && (
        <p className="text-xs text-muted-foreground">Распределение доступно после приёмки товара.</p>
      )}
    </div>
  );
}
