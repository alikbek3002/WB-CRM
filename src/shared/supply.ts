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
  status: SupplyStatus;
  receivedAt: string | null;
  receivedQty: number | null;
  receiptComment: string | null;
  transitDays: number | null;
  responsible: string;
  payments: SupplyPayment[];
  distributions: WbDistribution[];
};

// Сборка карточки Supply с вычислимыми полями (оплаты в ₽, недостача, срок, авто-статус)
export function assembleSupply(input: SupplyInput): Supply {
  const eff = effectiveSupplyStatus(input.status, input.shipDate);
  const paidGoodsRub = input.payments
    .filter((p) => p.kind === "goods")
    .reduce((t, p) => t + toRub(p.amount, p.currency), 0);
  const paidCargoRub = input.payments
    .filter((p) => p.kind === "cargo")
    .reduce((t, p) => t + toRub(p.amount, p.currency), 0);
  const totalDueRub =
    toRub(input.sewingCost, input.sewingCurrency) + toRub(input.cargoCost, input.cargoCurrency);
  const owedRub = Math.max(0, totalDueRub - paidGoodsRub - paidCargoRub);

  const shortage =
    input.receivedQty != null && input.receivedQty < input.quantity
      ? input.quantity - input.receivedQty
      : 0;

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
    payments: input.payments,
    paidGoodsRub,
    paidCargoRub,
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
export function computeFulfillment(supplies: Supply[]): FulfillmentSummary {
  const cards = supplies.filter((s) => FULFILLMENT_STAGES.includes(s.status));
  const qty = (s: Supply) => s.receivedQty ?? s.quantity;
  return {
    receivedQty: cards.reduce((t, s) => t + qty(s), 0),
    sortingQty: cards.filter((s) => s.status === "sorting").reduce((t, s) => t + qty(s), 0),
    inStockQty: cards.filter((s) => s.status === "in_stock").reduce((t, s) => t + qty(s), 0),
    distributedQty: cards
      .filter((s) => s.status === "distributed")
      .reduce((t, s) => t + (s.distributedQty || qty(s)), 0),
    shortageQty: cards.reduce((t, s) => t + s.shortage, 0),
    cards,
  };
}
