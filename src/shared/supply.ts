// Чистая доменная логика цепочки поставок — общая для mock- и supabase-ридеров.
// Сборка карточки Supply из «сырых» полей, авто-статус «Приехал», агрегаты фабрик и фул-фирмы.

import { SUPPLY_AUTO_ARRIVE_DAYS } from "@/shared/constants";
import { toBase, type CurrencyRateMap } from "@/shared/currency";
import type {
  Currency,
  Factory,
  FulfillmentCityRow,
  FulfillmentSummary,
  Supply,
  SupplyCountry,
  SupplyPayment,
  SupplyStatus,
  WbDistribution,
} from "@/shared/types";

export const SUPPLY_STATUS_LABELS: Record<SupplyStatus, string> = {
  in_transit: "В пути",
  arrived: "Приехал",
  received: "Принят",
  sorting: "В разборе",
  in_stock: "Лежит на складе",
  distributed: "Распределён по WB",
  cancelled: "Отменён",
};

// Стадии, на которых карточка уже принята фул-фирмой
export const FULFILLMENT_STAGES: SupplyStatus[] = [
  "received",
  "sorting",
  "in_stock",
  "distributed",
];

// Локальная дата из 'yyyy-mm-dd' (без сдвига UTC — пояс UTC+5/6)
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayLocal(): Date {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

function daysBetween(fromIso: string, to: Date): number {
  const from = parseLocalDate(fromIso);
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// Авто-статус: «В пути» дольше N дней → «Приехал» (derived-on-read)
export function effectiveSupplyStatus(
  status: SupplyStatus,
  shipDate: string,
): { status: SupplyStatus; autoArrived: boolean } {
  if (status === "in_transit" && daysBetween(shipDate, todayLocal()) >= SUPPLY_AUTO_ARRIVE_DAYS) {
    return { status: "arrived", autoArrived: true };
  }
  return { status, autoArrived: false };
}

export type SupplyItemInput = {
  id: string;
  productId: string | null;
  title: string;
  quantity: number;
  receivedQty: number | null;
  sewingCost: number;
  sewingCurrency: Currency;
  sewingRateToRub: number | null; // курс, зафиксированный при заведении
};

export type SupplyInput = {
  id: string;
  factoryId: string;
  factoryName: string;
  country: SupplyCountry;
  productId: string | null;
  title: string;
  quantity: number;
  shipDate: string;
  sewingCost: number;
  sewingCurrency: Currency;
  cargoCost: number;
  cargoCurrency: Currency;
  cargoRateToRub: number | null;
  status: SupplyStatus;
  receivedAt: string | null;
  receivedQty: number | null;
  receiptComment: string | null;
  transitDays: number | null;
  responsible: string;
  items: SupplyItemInput[];
  fulfillmentPartnerId: string | null;
  fulfillmentPartnerName: string | null;
  fulfillmentRatePerUnitRub: number;
  fulfillmentCostRub: number | null; // факт; null → тариф × принято
  unloadCity: string | null; // город разгрузки карго
  payments: SupplyPayment[];
  distributions: WbDistribution[];
};

// Сборка карточки Supply с вычислимыми полями (оплаты в сомах, недостача, срок,
// авто-статус, себестоимость единицы по позициям).
// rates — курсы к сому из currency_rates: отшив и карго идут в валюте фабрики
// (юань, доллар), а сводные суммы карточки — в базовой валюте.
export function assembleSupply(input: SupplyInput, rates?: CurrencyRateMap | null): Supply {
  const eff = effectiveSupplyStatus(input.status, input.shipDate);
  const paidOf = (kind: SupplyPayment["kind"]) =>
    input.payments
      .filter((p) => p.kind === kind)
      .reduce((t, p) => t + toBase(p.amount, p.currency, rates), 0);
  const paidGoodsRub = paidOf("goods");
  const paidCargoRub = paidOf("cargo");
  const paidFulfillmentRub = paidOf("fulfillment");

  // Позиции: если их нет — синтетическая одна из полей самой поставки
  // (карточки, заведённые до миграции 0037).
  const rawItems: SupplyItemInput[] = input.items.length
    ? input.items
    : [
        {
          id: input.id,
          productId: input.productId,
          title: input.title,
          quantity: input.quantity,
          receivedQty: input.receivedQty,
          sewingCost: input.sewingCost,
          sewingCurrency: input.sewingCurrency,
          sewingRateToRub: null,
        },
      ];

  const qtyOf = (i: SupplyItemInput) =>
    i.receivedQty != null && i.receivedQty > 0 ? i.receivedQty : i.quantity;
  const totalQty = rawItems.reduce((t, i) => t + qtyOf(i), 0);

  // Начисление фул-фирме: фактическая сумма важнее тарифа
  const fulfillmentRub =
    input.fulfillmentCostRub != null && input.fulfillmentCostRub > 0
      ? input.fulfillmentCostRub
      : Math.round(input.fulfillmentRatePerUnitRub * totalQty);

  const cargoRubTotal = toBase(input.cargoCost, input.cargoCurrency, rates);
  const cargoPerUnit = totalQty > 0 ? cargoRubTotal / totalQty : 0;
  const ffPerUnit = totalQty > 0 ? fulfillmentRub / totalQty : 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const items = rawItems.map((i) => {
    const qty = qtyOf(i);
    const sewingRub = qty > 0 ? toBase(i.sewingCost, i.sewingCurrency, rates) / qty : 0;
    return {
      id: i.id,
      productId: i.productId,
      title: i.title,
      quantity: i.quantity,
      receivedQty: i.receivedQty,
      sewingCost: i.sewingCost,
      sewingCurrency: i.sewingCurrency,
      sewingRub: r2(sewingRub),
      cargoRub: r2(cargoPerUnit),
      fulfillmentRub: r2(ffPerUnit),
      unitCostRub: r2(sewingRub + cargoPerUnit + ffPerUnit),
    };
  });

  const sewingTotalRub = rawItems.reduce(
    (t, i) => t + toBase(i.sewingCost, i.sewingCurrency, rates),
    0,
  );
  const totalDueRub = sewingTotalRub + cargoRubTotal + fulfillmentRub;
  const owedRub = Math.max(
    0,
    totalDueRub - paidGoodsRub - paidCargoRub - paidFulfillmentRub,
  );

  const shippedQty = rawItems.reduce((t, i) => t + i.quantity, 0);
  const receivedTotal = rawItems.some((i) => i.receivedQty != null)
    ? rawItems.reduce((t, i) => t + (i.receivedQty ?? 0), 0)
    : null;
  const shortage =
    receivedTotal != null && receivedTotal < shippedQty ? shippedQty - receivedTotal : 0;

  const distributedQty = input.distributions.reduce((t, d) => t + d.quantity, 0);

  // Срок: если принят — время в пути (transit_days либо received−ship); иначе — сколько уже едет
  const daysInTransit =
    input.transitDays != null
      ? input.transitDays
      : input.receivedAt != null
        ? daysBetween(input.shipDate, parseLocalDate(input.receivedAt))
        : eff.status === "distributed" || FULFILLMENT_STAGES.includes(eff.status)
          ? null
          : daysBetween(input.shipDate, todayLocal());

  return {
    id: input.id,
    factoryId: input.factoryId,
    factoryName: input.factoryName,
    country: input.country,
    productId: input.productId,
    title: input.title,
    quantity: input.quantity,
    shipDate: input.shipDate,
    sewingCost: input.sewingCost,
    sewingCurrency: input.sewingCurrency,
    cargoCost: input.cargoCost,
    cargoCurrency: input.cargoCurrency,
    status: eff.status,
    statusLabel: SUPPLY_STATUS_LABELS[eff.status],
    autoArrived: eff.autoArrived,
    daysInTransit,
    receivedAt: input.receivedAt,
    receivedQty: input.receivedQty,
    receiptComment: input.receiptComment,
    transitDays: input.transitDays,
    shortage,
    responsible: input.responsible,
    items,
    payments: input.payments,
    paidGoodsRub,
    paidCargoRub,
    paidFulfillmentRub,
    fulfillmentPartnerId: input.fulfillmentPartnerId,
    fulfillmentPartnerName: input.fulfillmentPartnerName,
    fulfillmentRub,
    unloadCity: input.unloadCity,
    owedRub,
    distributions: input.distributions,
    distributedQty,
  };
}

export type FactoryBase = {
  id: string;
  name: string;
  country: SupplyCountry;
  note: string | null;
  currency: Currency; // валюта расчётов с фабрикой
};

// Аналитика по фабрике: сколько отшили, на какую сумму (в сомах), в пути, ср. срок
export function computeFactories(
  factories: FactoryBase[],
  supplies: Supply[],
  rates?: CurrencyRateMap | null,
): Factory[] {
  return factories.map((f) => {
    const own = supplies.filter((s) => s.factoryId === f.id);
    const shippedSumRub = own.reduce(
      (t, s) =>
        t +
        toBase(s.sewingCost, s.sewingCurrency, rates) +
        toBase(s.cargoCost, s.cargoCurrency, rates),
      0,
    );
    const transitDone = own.filter((s) => s.transitDays != null);
    return {
      id: f.id,
      name: f.name,
      country: f.country,
      note: f.note,
      currency: f.currency,
      suppliesCount: own.length,
      shippedQty: own.reduce((t, s) => t + s.quantity, 0),
      shippedSumRub,
      inTransitCount: own.filter((s) => s.status === "in_transit" || s.status === "arrived").length,
      avgTransitDays: transitDone.length
        ? Math.round(transitDone.reduce((t, s) => t + (s.transitDays ?? 0), 0) / transitDone.length)
        : null,
    };
  });
}

// Сводка фул-фирмы: приняли / в разборе / лежит / распределено / недостачи
// и деньги — сколько ей начислено, оплачено и сколько должны.
export function computeFulfillment(supplies: Supply[]): FulfillmentSummary {
  const cards = supplies.filter((s) => FULFILLMENT_STAGES.includes(s.status));
  const qty = (s: Supply) => s.receivedQty ?? s.quantity;
  const chargedRub = cards.reduce((t, s) => t + s.fulfillmentRub, 0);
  const paidRub = cards.reduce((t, s) => t + s.paidFulfillmentRub, 0);

  // Разрез по городам разгрузки. Считаем по ВСЕМ поставкам, а не только по
  // стадиям фул-фирмы: карго, которое ещё едет в Казань, — это уже нагрузка
  // на казанскую точку, и планировать её надо заранее.
  const cityMap = new Map<string, FulfillmentCityRow>();
  for (const s of supplies) {
    const city = s.unloadCity?.trim() || "—";
    const row = cityMap.get(city) ?? { city, supplies: 0, qty: 0, chargedRub: 0 };
    row.supplies += 1;
    row.qty += qty(s);
    row.chargedRub += s.fulfillmentRub;
    cityMap.set(city, row);
  }
  // «—» (город не указан) всегда внизу — это хвост старых карточек
  const byCity = [...cityMap.values()].sort((a, b) => {
    if (a.city === "—") return 1;
    if (b.city === "—") return -1;
    return b.qty - a.qty || a.city.localeCompare(b.city);
  });

  return {
    byCity,
    receivedQty: cards.reduce((t, s) => t + qty(s), 0),
    sortingQty: cards.filter((s) => s.status === "sorting").reduce((t, s) => t + qty(s), 0),
    inStockQty: cards.filter((s) => s.status === "in_stock").reduce((t, s) => t + qty(s), 0),
    distributedQty: cards
      .filter((s) => s.status === "distributed")
      .reduce((t, s) => t + (s.distributedQty || qty(s)), 0),
    shortageQty: cards.reduce((t, s) => t + s.shortage, 0),
    chargedRub,
    paidRub,
    owedRub: Math.max(0, chargedRub - paidRub),
    cards,
  };
}
