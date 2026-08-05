// Чистая доменная логика цепочки поставок — общая для mock- и supabase-ридеров.
// Сборка карточки Supply из «сырых» полей, авто-статус «Приехал», агрегаты фабрик и фул-фирмы.

import { SUPPLY_AUTO_ARRIVE_DAYS, toRub } from "@/shared/constants";
import type {
  Currency,
  Factory,
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
  sewingRateToRub: number | null;
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
  payments: SupplyPayment[];
  distributions: WbDistribution[];
};

// Сборка карточки Supply с вычислимыми полями (оплаты в ₽, недостача, срок,
// авто-статус, себестоимость единицы по позициям).
export function assembleSupply(input: SupplyInput): Supply {
  const eff = effectiveSupplyStatus(input.status, input.shipDate);
  const paidOf = (kind: SupplyPayment["kind"]) =>
    input.payments
      .filter((p) => p.kind === kind)
      .reduce((t, p) => t + toRub(p.amount, p.currency), 0);
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

  const cargoRubTotal = toRub(input.cargoCost, input.cargoCurrency);
  const cargoPerUnit = totalQty > 0 ? cargoRubTotal / totalQty : 0;
  const ffPerUnit = totalQty > 0 ? fulfillmentRub / totalQty : 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const items = rawItems.map((i) => {
    const qty = qtyOf(i);
    const sewingRub = qty > 0 ? toRub(i.sewingCost, i.sewingCurrency) / qty : 0;
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
    (t, i) => t + toRub(i.sewingCost, i.sewingCurrency),
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
};

// Аналитика по фабрике: сколько отшили, на какую сумму (₽), в пути, ср. срок
export function computeFactories(factories: FactoryBase[], supplies: Supply[]): Factory[] {
  return factories.map((f) => {
    const own = supplies.filter((s) => s.factoryId === f.id);
    const shippedSumRub = own.reduce(
      (t, s) =>
        t + toRub(s.sewingCost, s.sewingCurrency) + toRub(s.cargoCost, s.cargoCurrency),
      0,
    );
    const transitDone = own.filter((s) => s.transitDays != null);
    return {
      id: f.id,
      name: f.name,
      country: f.country,
      note: f.note,
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
  return {
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
