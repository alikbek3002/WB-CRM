"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImageOff, Plus, Search, X } from "lucide-react";
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
import {
  CURRENCY_CODES,
  CURRENCY_LABEL,
  CURRENCY_SIGN,
  toBase,
  type CurrencyRateMap,
} from "@/shared/currency";
import { formatMoney, formatNumber, formatSom } from "@/shared/format";
import type {
  Currency,
  Supply,
  SupplyStatus,
  UnloadPoint,
  WbWarehouseRef,
} from "@/shared/types";

type FactoryOpt = {
  id: string;
  name: string;
  country: "china" | "uzbekistan";
  currency: Currency; // валюта расчётов фабрики — подставляется в отшив и карго
};
// Товар для привязки позиции: закупщик ищет его по артикулу и узнаёт по фото,
// поэтому кроме названия несём vendorCode, nmID и картинку.
type ProductOpt = {
  id: string;
  title: string;
  vendorCode: string;
  nmId: number;
  photoUrl: string | null;
};
type PartnerOpt = {
  id: string;
  name: string;
  ratePerUnitRub: number;
  city: string | null; // город разгрузки — им фильтруем список под выбранный город
};

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

// Фото товара с карточки WB. Размер задаём классом снаружи: в таблице нужна
// маленькая, в поиске — покрупнее. Нет фото — рисуем плашку, чтобы строки
// списка не прыгали по высоте.
function Thumb({
  url,
  alt,
  size = "size-9",
}: {
  url: string | null;
  alt: string;
  size?: string;
}) {
  if (!url) {
    return (
      <div
        className={`flex ${size} shrink-0 items-center justify-center rounded bg-muted/40 text-muted-foreground`}
      >
        <ImageOff className="size-3.5" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className={`${size} shrink-0 rounded bg-muted/40 object-cover`}
    />
  );
}

// Товары, к карточкам которых привязана поставка (шапка + позиции), без повторов
function linkedProducts(
  supply: Supply,
  productById: Map<string, ProductOpt>,
): ProductOpt[] {
  const ids = supply.items.map((i) => i.productId).filter((v): v is string => v != null);
  if (supply.productId) ids.unshift(supply.productId);
  const seen = new Set<string>();
  const out: ProductOpt[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = productById.get(id);
    if (p) out.push(p);
  }
  return out;
}

// Первая колонка списка: фото + название поставки + артикулы позиций —
// по ним поставку узнают быстрее, чем по названию карго.
function SupplyTitleCell({
  supply,
  productById,
}: {
  supply: Supply;
  productById: Map<string, ProductOpt>;
}) {
  const linked = linkedProducts(supply, productById);
  const codes = linked.slice(0, 2).map((p) => p.vendorCode).join(" · ");
  const rest = linked.length - Math.min(linked.length, 2);

  return (
    <div className="flex items-center gap-2">
      <Thumb url={linked[0]?.photoUrl ?? null} alt={supply.title} size="size-8" />
      <div className="min-w-0">
        <div className="truncate">{supply.title}</div>
        {codes && (
          <div className="truncate text-[11px] font-normal text-muted-foreground">
            {codes}
            {rest > 0 && ` +${rest}`}
          </div>
        )}
      </div>
    </div>
  );
}

export function SuppliesBoard({
  supplies,
  factories,
  products,
  partners,
  unloadPoints,
  wbWarehouses,
  rates,
  canEdit,
  canPay,
  canReceive,
}: {
  supplies: Supply[];
  factories: FactoryOpt[];
  products: ProductOpt[];
  partners: PartnerOpt[];
  unloadPoints: UnloadPoint[]; // города разгрузки: фул-фирмы + свои склады WB
  wbWarehouses: WbWarehouseRef[]; // склады WB для распределения после разбора
  rates: CurrencyRateMap; // курсы к сому: предпросчёт себестоимости в форме
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
  // Позиции хранят только product_id — артикул и фото подтягиваем из каталога
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

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
                <TableHead>Фабрика → разгрузка</TableHead>
                <TableHead className="text-right">Кол-во</TableHead>
                <TableHead>Отгружено</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">В пути</TableHead>
                <TableHead className="text-right">Долг, сом</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <SupplyTitleCell supply={s} productById={productById} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.factoryName}
                    {s.unloadCity && (
                      <span className="block text-[11px]">→ {s.unloadCity}</span>
                    )}
                  </TableCell>
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
                      <span className="text-amber-400">{formatSom(s.owedRub)}</span>
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
          unloadPoints={unloadPoints}
          rates={rates}
          open={createOpen}
          onOpenChange={setCreateOpen}
          factories={factories}
          products={products}
        />
      )}

      <SupplyDetailDialog
        supply={detail}
        productById={productById}
        wbWarehouses={wbWarehouses}
        onClose={() => setDetailId(null)}
        canPay={canPay}
        canReceive={canReceive}
      />
    </div>
  );
}

// ─── Выбор товара позиции по артикулу ─────────────────────────────────────────

// Закупщик держит в голове артикулы, а не названия карточек WB («PJ-104», а не
// «Пижама женская тёплая с начёсом…»), поэтому вместо длинного выпадающего
// списка — поиск: артикул продавца, nmID или кусок названия. Список рисуем
// прямо в потоке (диалог скроллится сам) — так он не обрезается краем окна и
// не тянет за собой поповер.
const MAX_HITS = 40;

function ProductPicker({
  products,
  value,
  onPick,
}: {
  products: ProductOpt[];
  value: string; // id товара или "none" — без привязки к WB
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);

  const selected = value === "none" ? null : products.find((p) => p.id === value) ?? null;

  // После «Сменить» фокус уводим в поиск — иначе пришлось бы целиться мышью
  useEffect(() => {
    if (!selected && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
    }
  }, [selected]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, MAX_HITS);
    const found = products.filter(
      (p) =>
        p.vendorCode.toLowerCase().includes(q) ||
        String(p.nmId).includes(q) ||
        p.title.toLowerCase().includes(q),
    );
    // Артикул обычно вводят с начала — такие совпадения поднимаем наверх
    const rank = (p: ProductOpt) => {
      const vc = p.vendorCode.toLowerCase();
      if (vc.startsWith(q)) return 0;
      if (vc.includes(q)) return 1;
      if (String(p.nmId).startsWith(q)) return 2;
      return 3;
    };
    found.sort((a, b) => rank(a) - rank(b) || a.vendorCode.localeCompare(b.vendorCode));
    return found.slice(0, MAX_HITS);
  }, [products, query]);

  function pick(id: string) {
    onPick(id);
    setQuery("");
    setOpen(false);
  }

  if (selected) {
    return (
      <div className="flex flex-1 items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2 py-1">
        <Thumb url={selected.photoUrl} alt={selected.title} size="size-9" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{selected.vendorCode}</div>
          <div className="truncate text-[10px] leading-tight text-muted-foreground">
            {selected.title} · {selected.nmId}
          </div>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            wantFocus.current = true;
            pick("none");
            setOpen(true);
          }}
        >
          Сменить
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              if (open && hits[active]) {
                e.preventDefault();
                pick(hits[active].id);
              }
            } else if (e.key === "Escape" && open) {
              // Гасим здесь, иначе Escape закрыл бы всю форму поставки
              e.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder="Артикул, nmID или название"
          className="h-8 pl-7"
        />
      </div>

      {open ? (
        <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-popover">
          {hits.map((p, n) => (
            <button
              key={p.id}
              type="button"
              // Без этого input теряет фокус раньше клика и список успевает закрыться
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(n)}
              onClick={() => pick(p.id)}
              className={`flex w-full items-center gap-2 border-b border-border/40 px-2 py-1.5 text-left last:border-0 ${
                n === active ? "bg-muted/60" : "hover:bg-muted/40"
              }`}
            >
              <Thumb url={p.photoUrl} alt={p.title} size="size-9" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{p.vendorCode}</div>
                <div className="truncate text-[10px] leading-tight text-muted-foreground">
                  {p.title} · {p.nmId}
                </div>
              </div>
            </button>
          ))}
          {hits.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              По «{query.trim()}» ничего не нашли — проверьте артикул или оставьте позицию
              без привязки к WB.
            </div>
          )}
          {hits.length === MAX_HITS && (
            <div className="border-t border-border/40 px-2 py-1 text-[10px] text-muted-foreground">
              показаны первые {MAX_HITS} — уточните артикул
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
          Не нашли карточку — оставьте пустым, позиция уйдёт без привязки к WB.
        </p>
      )}
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
  unloadPoints,
  rates,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factories: FactoryOpt[];
  products: ProductOpt[];
  partners: PartnerOpt[];
  unloadPoints: UnloadPoint[];
  rates: CurrencyRateMap;
}) {
  const router = useRouter();
  const [factoryId, setFactoryId] = useState(factories[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [shipDate, setShipDate] = useState(todayIso());
  const [items, setItems] = useState<ItemDraft[]>([emptyItem("cny")]);
  const [cargoCost, setCargoCost] = useState("");
  const [cargoCurrency, setCargoCurrency] = useState<Currency>("cny");
  const [partnerId, setPartnerId] = useState("none");
  // Куда разгружаем: город из справочника («other» — свой, вводится руками)
  const [city, setCity] = useState("none");
  const [cityOther, setCityOther] = useState("");
  const [saving, setSaving] = useState(false);

  const unloadCity = city === "none" ? "" : city === "other" ? cityOther.trim() : city;

  // Фул-фирмы показываем те, что стоят в выбранном городе (плюс без города —
  // их ещё не донастроили). Без выбора города — все.
  const partnersInCity = unloadCity
    ? partners.filter((p) => !p.city || p.city === unloadCity)
    : partners;

  function pickCity(value: string) {
    setCity(value);
    // Сменили город — фул-фирма из прошлого города больше не подходит
    const chosen = partners.find((p) => p.id === partnerId);
    if (chosen?.city && value !== "other" && chosen.city !== value) setPartnerId("none");
  }

  function pickPartner(id: string) {
    setPartnerId(id);
    // Город не выбирали — берём из фул-фирмы: обычно он и есть ответ
    const p = partners.find((x) => x.id === id);
    if (p?.city && city === "none") setCity(p.city);
  }

  function pickFactory(id: string) {
    setFactoryId(id);
    const f = factories.find((x) => x.id === id);
    // Валюта берётся у фабрики (её задают в карточке фабрики): китайская может
    // считать и в юанях, и в долларах — угадывать по стране больше нельзя.
    const cur: Currency = f?.currency ?? (f?.country === "uzbekistan" ? "uzs" : "cny");
    setCargoCurrency(cur);
    setItems((prev) => prev.map((i) => ({ ...i, sewingCurrency: cur })));
  }

  const patchItem = (idx: number, patch: Partial<ItemDraft>) =>
    setItems((prev) => prev.map((i, n) => (n === idx ? { ...i, ...patch } : i)));

  function pickItemProduct(idx: number, id: string) {
    const cur = items[idx];
    const prev = products.find((x) => x.id === cur.productId) ?? null;
    const next = products.find((x) => x.id === id) ?? null;
    // Наименование ведём за карточкой, пока его не правили руками: если там
    // стоит название прошлого выбранного товара — это наша подстановка, её и
    // заменяем. Свой текст закупщика не трогаем.
    const manual = cur.title.trim() !== "" && cur.title.trim() !== (prev?.title ?? "").trim();
    patchItem(idx, {
      productId: id,
      title: manual ? cur.title : next?.title ?? "",
    });
  }

  // Предпросчёт себестоимости единицы — та же формула, что и на приёмке
  // (backend/data/cost-core.ts): карго и услуги ФФ делятся между позициями
  // пропорционально количеству.
  const totalQty = items.reduce((t, i) => t + (Number(i.quantity) || 0), 0);
  const partner = partners.find((p) => p.id === partnerId) ?? null;
  const cargoRub = toBase(Number(cargoCost) || 0, cargoCurrency, rates);
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
          unloadCity: unloadCity || null,
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
      setCity("none");
      setCityOther("");
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
              const sewingPerUnit = qty > 0 ? toBase(Number(item.sewingCost) || 0, item.sewingCurrency, rates) / qty : 0;
              return (
                <div key={idx} className="space-y-1.5 rounded-md bg-muted/20 p-2">
                  <div className="flex items-start gap-2">
                    <ProductPicker
                      products={products}
                      value={item.productId}
                      onPick={(id) => pickItemProduct(idx, id)}
                    />
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
                          {CURRENCY_CODES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {CURRENCY_SIGN[c]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {qty > 0 && (
                    <div className="text-[10px] leading-tight text-muted-foreground">
                      себестоимость ≈ {formatSom(Math.round(sewingPerUnit + perUnitShared))}/шт
                      {perUnitShared > 0 &&
                        ` (отшив ${formatSom(Math.round(sewingPerUnit))} + карго и ФФ ${formatSom(Math.round(perUnitShared))})`}
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

          {/* Куда приезжает карго с фабрики. Города берём из справочника:
              фул-фирмы + личные склады кабинета WB (город у них из офисов WB),
              поэтому «Санкт-Петербург» не превращается в «Спб» и «СПБ». */}
          <div className="grid gap-1.5">
            <Label>Куда разгружаем</Label>
            <Select value={city} onValueChange={(v) => v && pickCity(String(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Город не указан</SelectItem>
                {unloadPoints.map((p) => (
                  <SelectItem key={p.city} value={p.city}>
                    {p.city}
                    {p.partnerNames.length > 0 && ` · ${p.partnerNames.join(", ")}`}
                    {p.partnerNames.length === 0 &&
                      p.fbsWarehouseNames.length > 0 &&
                      ` · ${p.fbsWarehouseNames.join(", ")}`}
                  </SelectItem>
                ))}
                <SelectItem value="other">Другой город…</SelectItem>
              </SelectContent>
            </Select>
            {city === "other" && (
              <Input
                value={cityOther}
                onChange={(e) => setCityOther(e.target.value)}
                placeholder="Например, Новосибирск"
              />
            )}
            {unloadPoints.length === 0 && city !== "other" && (
              <p className="text-xs text-muted-foreground">
                Городов пока нет — укажите город у фул-фирмы на странице «Фул-фирма»,
                либо выберите «Другой город».
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>Фул-фирма (разбор и упаковка)</Label>
            <Select value={partnerId} onValueChange={(v) => v && pickPartner(String(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Не привлекаем</SelectItem>
                {partnersInCity.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.city && ` · ${p.city}`} · {formatSom(p.ratePerUnitRub)}/шт
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {unloadCity && partnersInCity.length === 0 && (
              <p className="text-xs text-muted-foreground">
                В городе «{unloadCity}» фул-фирм не заведено — разбираем сами.
              </p>
            )}
            {partner && totalQty > 0 && (
              <p className="text-xs text-muted-foreground">
                Начислим {formatSom(ffRub)} за {formatNumber(totalQty)} шт — войдёт в себестоимость.
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
  productById,
  wbWarehouses,
  onClose,
  canPay,
  canReceive,
}: {
  supply: Supply | null;
  productById: Map<string, ProductOpt>;
  wbWarehouses: WbWarehouseRef[];
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
                {supply.factoryName}
                {supply.unloadCity && ` → ${supply.unloadCity}`} · {supply.statusLabel}
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
                <OverviewTab supply={supply} productById={productById} />
              </TabsContent>
              <TabsContent value="finance" className="pt-3">
                <FinanceTab supply={supply} canPay={canPay} />
              </TabsContent>
              <TabsContent value="receipt" className="pt-3">
                <ReceiptTab supply={supply} canReceive={canReceive} />
              </TabsContent>
              <TabsContent value="distribute" className="pt-3">
                <DistributeTab
                  supply={supply}
                  wbWarehouses={wbWarehouses}
                  canReceive={canReceive}
                />
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

function OverviewTab({
  supply,
  productById,
}: {
  supply: Supply;
  productById: Map<string, ProductOpt>;
}) {
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
          value={formatSom(supply.fulfillmentRub)}
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
            {supply.items.map((i) => {
              const p = i.productId ? productById.get(i.productId) ?? null : null;
              return (
                <div key={i.id} className="flex gap-2 rounded-md bg-muted/20 px-2.5 py-1.5">
                  <Thumb url={p?.photoUrl ?? null} alt={i.title} size="size-10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium">{i.title}</span>
                      <span className="shrink-0 tabular-nums">
                        {formatNumber(i.receivedQty ?? i.quantity)} шт
                      </span>
                    </div>
                    {p && (
                      <div className="truncate text-[11px] leading-tight text-muted-foreground">
                        арт. {p.vendorCode} · {p.nmId}
                      </div>
                    )}
                    <div className="text-[11px] leading-tight text-muted-foreground">
                      {formatSom(i.unitCostRub)}/шт = отшив {formatSom(i.sewingRub)} + карго{" "}
                      {formatSom(i.cargoRub)}
                      {i.fulfillmentRub > 0 && ` + фул-фирма ${formatSom(i.fulfillmentRub)}`}
                    </div>
                  </div>
                </div>
              );
            })}
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
        <Row label="Оплачено за товар" value={formatSom(supply.paidGoodsRub)} />
        <Row label="Оплачено за карго" value={formatSom(supply.paidCargoRub)} />
        {(supply.fulfillmentRub > 0 || supply.paidFulfillmentRub > 0) && (
          <Row label="Оплачено фул-фирме" value={formatSom(supply.paidFulfillmentRub)} />
        )}
        <div className="flex items-center justify-between gap-2 py-1 text-sm">
          <span className="text-muted-foreground">Остаток долга</span>
          <span className={`tabular-nums font-medium ${supply.owedRub > 0 ? "text-amber-400" : "text-emerald-400"}`}>
            {supply.owedRub > 0 ? formatSom(supply.owedRub) : "нет"}
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

function DistributeTab({
  supply,
  wbWarehouses,
  canReceive,
}: {
  supply: Supply;
  wbWarehouses: WbWarehouseRef[];
  canReceive: boolean;
}) {
  const router = useRouter();
  // Склад выбираем из справочника WB (supplies-api, 0042). «other» — вручную:
  // список у WB меняется, и вбить новый склад должно быть можно сразу.
  const active = wbWarehouses.filter((w) => w.isActive);
  const [warehouse, setWarehouse] = useState(active.length > 0 ? "none" : "other");
  const [warehouseOther, setWarehouseOther] = useState("");
  const [qty, setQty] = useState("");
  const [saving, setSaving] = useState(false);
  const received = supply.receivedAt != null;
  const remaining = (supply.receivedQty ?? supply.quantity) - supply.distributedQty;
  const warehouseName =
    warehouse === "other" ? warehouseOther.trim() : warehouse === "none" ? "" : warehouse;

  async function distribute() {
    if (!warehouseName) return toast.error("Укажите склад WB");
    if (!(Number(qty) > 0)) return toast.error("Укажите количество");
    setSaving(true);
    try {
      const res = await fetch(`/api/supplies/${supply.id}/distribute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warehouse: warehouseName, quantity: Number(qty) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(data.persisted ? `Отправлено на «${warehouseName}»` : "Распределение принято (демо)");
      setWarehouse(active.length > 0 ? "none" : "other");
      setWarehouseOther("");
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
            {active.length > 0 ? (
              <Select value={warehouse} onValueChange={(v) => v && setWarehouse(String(v))}>
                <SelectTrigger className="h-8 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Выберите склад WB</SelectItem>
                  {active.map((w) => (
                    <SelectItem key={w.wbId} value={w.name}>
                      {w.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="other">Другой склад…</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={warehouseOther}
                onChange={(e) => setWarehouseOther(e.target.value)}
                placeholder="Коледино"
                className="h-8 flex-1"
              />
            )}
            <Input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Кол-во"
              className="h-8 w-24"
            />
            <Button size="sm" onClick={distribute} disabled={saving}>
              {saving ? "…" : "OK"}
            </Button>
          </div>
          {warehouse === "other" && active.length > 0 && (
            <Input
              value={warehouseOther}
              onChange={(e) => setWarehouseOther(e.target.value)}
              placeholder="Название склада WB"
              className="h-8"
            />
          )}
          {active.length === 0 && (
            <p className="text-[10px] leading-tight text-muted-foreground">
              Справочник складов WB пуст — подтянется после ближайшей синхронизации.
            </p>
          )}
        </div>
      )}
      {!received && (
        <p className="text-xs text-muted-foreground">Распределение доступно после приёмки товара.</p>
      )}
    </div>
  );
}
