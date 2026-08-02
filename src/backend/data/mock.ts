// Демо-данные до подключения ключей Supabase/WB.
// Генерация детерминированная (seeded PRNG) — цифры стабильны между рендерами.

import type {
  Currency,
  DashboardData,
  DailyPoint,
  Factory,
  FinanceRow,
  FulfillmentSummary,
  IntegrationStatus,
  ProductListItem,
  RnpDay,
  RnpProduct,
  RnpWeek,
  Supply,
  SupplyPayment,
  SupplyStatus,
  Tariff,
  TaskItem,
  TeamMember,
  WarehouseStock,
  WbDistribution,
} from "@/shared/types";
import {
  assembleSupply,
  computeFactories,
  computeFulfillment,
  type FactoryBase,
  type SupplyInput,
} from "@/shared/supply";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function dayLabel(d: Date) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

// Локальная дата (не toISOString — тот сдвигает день в поясах восточнее UTC)
function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBack(n: number): Date[] {
  const out: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}

// Одна дата на N дней назад (локально)
function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

// ─── Дашборд ────────────────────────────────────────────────────────────────

const WAREHOUSES = [
  "Коледино",
  "Электросталь",
  "Казань",
  "Краснодар",
  "Тула",
  "Невинномысск",
];

export function getDashboardData(): DashboardData {
  const rnd = mulberry32(42);
  const days = daysBack(30);

  const ordersDynamics: DailyPoint[] = days.map((d) => {
    const weekendBoost = d.getDay() === 0 || d.getDay() === 6 ? 1.25 : 1;
    const qty = Math.round((38 + rnd() * 34) * weekendBoost);
    return {
      date: isoDate(d),
      label: dayLabel(d),
      qty,
      sumRub: Math.round(qty * (2350 + rnd() * 600)),
    };
  });

  const stocksByWarehouse: WarehouseStock[] = WAREHOUSES.map((w) => ({
    warehouse: w,
    qty: Math.round(180 + rnd() * 1400),
  })).sort((a, b) => b.qty - a.qty);

  const ordersQty = ordersDynamics.reduce((s, p) => s + p.qty, 0);
  const ordersRub = ordersDynamics.reduce((s, p) => s + p.sumRub, 0);
  const salesQty = Math.round(ordersQty * 0.71);
  const salesRub = Math.round(ordersRub * 0.69);
  const profitRub = Math.round(salesRub * 0.238);

  return {
    kpis: {
      profitRub,
      profitabilityPct: 23.8,
      salesRub,
      salesQty,
      ordersRub,
      ordersQty,
      stockQty: stocksByWarehouse.reduce((s, w) => s + w.qty, 0),
      stockWarehouses: stocksByWarehouse.length,
    },
    ordersDynamics,
    ordersTrend: ordersDynamics,
    stocksByWarehouse,
    updatedAt: new Date().toISOString(),
  };
}

// ─── РНП ────────────────────────────────────────────────────────────────────

const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL"];

type RnpSeed = {
  id: string;
  nmId: number;
  tabLabel: string;
  title: string;
  status: string;
  responsible: string;
  price: number;
  cost: number;
  seed: number;
};

const RNP_SEEDS: RnpSeed[] = [
  {
    id: "p1",
    nmId: 173562489,
    tabLabel: "Кимоно",
    title: "Кимоно шёлковое, айвори",
    status: "Локомотив",
    responsible: "Марат Менеджеров",
    price: 3190,
    cost: 1140,
    seed: 101,
  },
  {
    id: "p2",
    nmId: 168227314,
    tabLabel: "Рубашка",
    title: "Рубашка оверсайз, белая",
    status: "Растущий",
    responsible: "Алия Сатпаева",
    price: 2290,
    cost: 820,
    seed: 202,
  },
  {
    id: "p3",
    nmId: 159948120,
    tabLabel: "костюм_гипюр_айвори",
    title: "Костюм гипюровый, айвори",
    status: "Новинка",
    responsible: "Марат Менеджеров",
    price: 4590,
    cost: 1830,
    seed: 303,
  },
  {
    id: "p4",
    nmId: 149301877,
    tabLabel: "Платье вечернее",
    title: "Платье вечернее макси, чёрное",
    status: "Стабильный",
    responsible: "Алия Сатпаева",
    price: 3890,
    cost: 1460,
    seed: 404,
  },
];

function buildRnpProduct(s: RnpSeed): RnpProduct {
  const rnd = mulberry32(s.seed);

  // Текущая неделя: понедельник — сегодня
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

  const days: RnpDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const future = d > today;
    const plan = Math.round(10 + rnd() * 14);
    const fact = future ? 0 : Math.round(plan * (0.6 + rnd() * 0.7));
    const salesPlan = Math.round(plan * 0.75);
    const salesFact = future ? 0 : Math.round(fact * (0.62 + rnd() * 0.25));
    const views = future ? 0 : Math.round(2800 + rnd() * 4200);
    const clicks = future ? 0 : Math.round(views * (0.021 + rnd() * 0.02));
    const cartQty = future ? 0 : Math.round(clicks * (0.28 + rnd() * 0.2));
    days.push({
      date: isoDate(d),
      label: `${dayLabel(d)} ${WEEKDAYS[d.getDay()]}`,
      ordersFact: fact,
      ordersPlan: plan,
      sppPct: future ? 0 : Math.round((17 + rnd() * 9) * 10) / 10,
      salesFact,
      salesPlan,
      avgCheck: future ? 0 : Math.round(s.price * (0.92 + rnd() * 0.1)),
      giveaways: future ? 0 : Math.round(rnd() * 3),
      ordersSumRub: Math.round(fact * s.price),
      salesSumRub: Math.round(salesFact * s.price * 0.97),
      views,
      clicks,
      ctrPct: views ? Math.round((clicks / views) * 1000) / 10 : 0,
      cartQty,
      cartPct: clicks ? Math.round((cartQty / clicks) * 1000) / 10 : 0,
      orderPct: cartQty ? Math.round((fact / cartQty) * 1000) / 10 : 0,
      croPct: views ? Math.round((fact / views) * 10000) / 100 : 0,
    });
  }

  const weeks: RnpWeek[] = [];
  for (let w = 0; w < 5; w++) {
    const plan = Math.round(80 + rnd() * 60);
    const fact = w < 4 ? Math.round(plan * (0.7 + rnd() * 0.45)) : 0;
    const salesPlan = Math.round(plan * 0.75);
    const salesFact = w < 4 ? Math.round(fact * 0.72) : 0;
    weeks.push({
      label: `Нед ${w + 1}`,
      ordersFact: fact,
      ordersPlan: plan,
      salesFact,
      salesPlan,
      ordersSumRub: Math.round(fact * s.price),
      salesSumRub: Math.round(salesFact * s.price * 0.97),
    });
  }
  weeks.push({
    label: "ИТОГ",
    ordersFact: weeks.reduce((t, w) => t + w.ordersFact, 0),
    ordersPlan: weeks.reduce((t, w) => t + w.ordersPlan, 0),
    salesFact: weeks.reduce((t, w) => t + w.salesFact, 0),
    salesPlan: weeks.reduce((t, w) => t + w.salesPlan, 0),
    ordersSumRub: weeks.reduce((t, w) => t + w.ordersSumRub, 0),
    salesSumRub: weeks.reduce((t, w) => t + w.salesSumRub, 0),
  });

  const onStock = SIZES.map(() => Math.round(rnd() * 90));
  const inTransit = SIZES.map(() => Math.round(rnd() * 40));
  const inProduction = SIZES.map(() => Math.round(rnd() * 60));

  const logistics = Math.round(70 + rnd() * 60);
  const commission = Math.round(s.price * 0.245);
  const profitPerUnit = s.price - s.cost - commission - logistics;
  const monthSales = weeks[5].salesFact;

  return {
    id: s.id,
    nmId: s.nmId,
    tabLabel: s.tabLabel,
    title: s.title,
    status: s.status,
    responsible: s.responsible,
    economics: {
      costPrice: s.cost,
      logistics,
      priceRub: s.price,
      profitRub: profitPerUnit * Math.max(monthSales, 1),
      marginPct: Math.round((profitPerUnit / s.price) * 1000) / 10,
      profitabilityPct: Math.round((profitPerUnit / s.cost) * 1000) / 10,
      drrPct: Math.round((6 + rnd() * 9) * 10) / 10,
      ctrPct: Math.round((2.1 + rnd() * 2.4) * 10) / 10,
      views: Math.round(48000 + rnd() * 90000),
      buyoutPct: Math.round((62 + rnd() * 26) * 10) / 10,
      croPct: Math.round((0.9 + rnd() * 2.1) * 100) / 100,
      sppPct: Math.round((16 + rnd() * 10) * 10) / 10,
    },
    sizeMatrix: {
      sizes: SIZES,
      rows: [
        { label: "На складе", values: onStock },
        { label: "В пути", values: inTransit },
        {
          label: "Общий",
          values: SIZES.map((_, i) => onStock[i] + inTransit[i]),
        },
        { label: "В пошиве", values: inProduction },
      ],
    },
    days,
    weeks,
  };
}

export function getRnpProducts(): RnpProduct[] {
  return RNP_SEEDS.map(buildRnpProduct);
}

// ─── Товары ─────────────────────────────────────────────────────────────────

// Демо-скорость продаж за 30 дней по товару (шт). p3 — слабый, p1 — локомотив.
const SALES_30D: Record<string, number> = { p1: 642, p2: 301, p3: 88, p4: 214 };

export function getProductList(): ProductListItem[] {
  const rnd = mulberry32(7);
  const supplies = getSupplies();
  return RNP_SEEDS.map((s) => {
    const stockQty = Math.round(120 + rnd() * 700);
    const salesRank30d = SALES_30D[s.id] ?? 0;
    // делим на неокруглённую скорость (округление — только для отображения)
    const avgExact = salesRank30d / 30;
    const avgDailySales = Math.round(avgExact * 10) / 10;
    const daysOfCover = avgExact > 0 ? Math.round(stockQty / avgExact) : null;
    const inTransitToMoscow = supplies
      .filter(
        (sup) =>
          sup.productId === s.id &&
          (sup.status === "in_transit" || sup.status === "arrived"),
      )
      .reduce((t, sup) => t + sup.quantity, 0);
    const isWeak = salesRank30d < 120 || (daysOfCover !== null && daysOfCover > 120);
    return {
      id: s.id,
      nmId: s.nmId,
      vendorCode: `ART-${String(s.nmId).slice(0, 5)}`,
      title: s.title,
      brand: "Kimono Brand",
      category:
        s.tabLabel === "Рубашка"
          ? "Рубашки"
          : s.tabLabel === "Платье вечернее"
            ? "Платья"
            : "Костюмы",
      status: s.status,
      costPrice: s.cost,
      costPriceSource: "manual" as const,
      costPriceUpdatedAt: null,
      econ: null,
      logisticsCost: Math.round(70 + rnd() * 60),
      stockQty,
      responsible: s.responsible,
      photoUrl: null,
      photos: [],
      description: null,
      priceWb: null,
      priceDiscountedWb: null,
      inTransitToMoscow,
      avgDailySales,
      daysOfCover,
      salesRank30d,
      isWeak,
    };
  });
}

// ─── Цепочка поставок (Фабрики · Поставки · Фул-фирма) ───────────────────────

const MOCK_FACTORIES: FactoryBase[] = [
  { id: "f-china", name: "Guangzhou Textile Co.", country: "china", note: "Основной трикотаж/шёлк" },
  { id: "f-uz", name: "Toshkent Tekstil", country: "uzbekistan", note: "Хлопок, костюмы, гипюр" },
];

const PRODUCT_TITLE: Record<string, string> = Object.fromEntries(
  RNP_SEEDS.map((s) => [s.id, s.title]),
);
const FACTORY_BY_ID = new Map(MOCK_FACTORIES.map((f) => [f.id, f]));

type SupplySeed = {
  id: string;
  factory: "f-china" | "f-uz";
  product: string;
  quantity: number;
  shipDaysAgo: number;
  sewingCost: number;
  sewingCurrency: Currency;
  cargoCost: number;
  cargoCurrency: Currency;
  status: SupplyStatus;
  receivedDaysAgo?: number;
  receivedQty?: number;
  receiptComment?: string;
  responsible: string;
  payments: { kind: "goods" | "cargo"; amount: number; currency: Currency; paidDaysAgo: number }[];
  distributions?: { warehouse: string; quantity: number }[];
};

const SUPPLY_SEEDS: SupplySeed[] = [
  {
    id: "s1", factory: "f-china", product: "p1", quantity: 300, shipDaysAgo: 6,
    sewingCost: 18000, sewingCurrency: "cny", cargoCost: 4200, cargoCurrency: "cny",
    status: "in_transit", responsible: "Марат Менеджеров",
    payments: [{ kind: "goods", amount: 10000, currency: "cny", paidDaysAgo: 4 }],
  },
  {
    id: "s2", factory: "f-china", product: "p3", quantity: 200, shipDaysAgo: 20,
    sewingCost: 24000, sewingCurrency: "cny", cargoCost: 5000, cargoCurrency: "cny",
    status: "in_transit", responsible: "Марат Менеджеров",
    payments: [
      { kind: "goods", amount: 24000, currency: "cny", paidDaysAgo: 19 },
      { kind: "cargo", amount: 5000, currency: "cny", paidDaysAgo: 18 },
    ],
  },
  {
    id: "s3", factory: "f-uz", product: "p2", quantity: 500, shipDaysAgo: 12,
    sewingCost: 9_000_000, sewingCurrency: "uzs", cargoCost: 1_500_000, cargoCurrency: "uzs",
    status: "arrived", responsible: "Алия Сатпаева",
    payments: [{ kind: "goods", amount: 5_000_000, currency: "uzs", paidDaysAgo: 9 }],
  },
  {
    id: "s4", factory: "f-china", product: "p4", quantity: 250, shipDaysAgo: 30,
    sewingCost: 21000, sewingCurrency: "cny", cargoCost: 4800, cargoCurrency: "cny",
    status: "received", receivedDaysAgo: 16, receivedQty: 240,
    receiptComment: "Недостача 10 шт — брак, зафиксировано при вскрытии", responsible: "Пётр Приёмщиков",
    payments: [
      { kind: "goods", amount: 21000, currency: "cny", paidDaysAgo: 28 },
      { kind: "cargo", amount: 4800, currency: "cny", paidDaysAgo: 27 },
    ],
  },
  {
    id: "s5", factory: "f-uz", product: "p1", quantity: 400, shipDaysAgo: 34,
    sewingCost: 7_600_000, sewingCurrency: "uzs", cargoCost: 1_200_000, cargoCurrency: "uzs",
    status: "sorting", receivedDaysAgo: 20, receivedQty: 400,
    receiptComment: "Пришёл весь товар", responsible: "Пётр Приёмщиков",
    payments: [{ kind: "goods", amount: 7_600_000, currency: "uzs", paidDaysAgo: 33 }],
  },
  {
    id: "s6", factory: "f-china", product: "p2", quantity: 350, shipDaysAgo: 45,
    sewingCost: 15000, sewingCurrency: "cny", cargoCost: 3600, cargoCurrency: "cny",
    status: "in_stock", receivedDaysAgo: 30, receivedQty: 350,
    receiptComment: "Пришёл весь товар", responsible: "Пётр Приёмщиков",
    payments: [
      { kind: "goods", amount: 15000, currency: "cny", paidDaysAgo: 44 },
      { kind: "cargo", amount: 3600, currency: "cny", paidDaysAgo: 43 },
    ],
  },
  {
    id: "s7", factory: "f-uz", product: "p3", quantity: 220, shipDaysAgo: 55,
    sewingCost: 8_800_000, sewingCurrency: "uzs", cargoCost: 1_400_000, cargoCurrency: "uzs",
    status: "distributed", receivedDaysAgo: 40, receivedQty: 220,
    receiptComment: "Пришёл весь товар", responsible: "Пётр Приёмщиков",
    payments: [
      { kind: "goods", amount: 8_800_000, currency: "uzs", paidDaysAgo: 54 },
      { kind: "cargo", amount: 1_400_000, currency: "uzs", paidDaysAgo: 53 },
    ],
    distributions: [
      { warehouse: "Коледино", quantity: 120 },
      { warehouse: "Казань", quantity: 100 },
    ],
  },
];

function seedToInput(seed: SupplySeed): SupplyInput {
  const factory = FACTORY_BY_ID.get(seed.factory)!;
  const shipDate = isoDate(daysAgo(seed.shipDaysAgo));
  const receivedAt =
    seed.receivedDaysAgo != null ? isoDate(daysAgo(seed.receivedDaysAgo)) : null;
  const transitDays =
    seed.receivedDaysAgo != null ? Math.max(0, seed.shipDaysAgo - seed.receivedDaysAgo) : null;
  const payments: SupplyPayment[] = seed.payments.map((p, i) => ({
    id: `${seed.id}-pay-${i}`,
    kind: p.kind,
    amount: p.amount,
    currency: p.currency,
    paidAt: isoDate(daysAgo(p.paidDaysAgo)),
    note: null,
  }));
  const distributions: WbDistribution[] = (seed.distributions ?? []).map((d, i) => ({
    id: `${seed.id}-dist-${i}`,
    warehouse: d.warehouse,
    quantity: d.quantity,
  }));
  return {
    id: seed.id,
    factoryId: factory.id,
    factoryName: factory.name,
    country: factory.country,
    productId: seed.product,
    title: PRODUCT_TITLE[seed.product] ?? seed.product,
    quantity: seed.quantity,
    shipDate,
    sewingCost: seed.sewingCost,
    sewingCurrency: seed.sewingCurrency,
    cargoCost: seed.cargoCost,
    cargoCurrency: seed.cargoCurrency,
    status: seed.status,
    receivedAt,
    receivedQty: seed.receivedQty ?? null,
    receiptComment: seed.receiptComment ?? null,
    transitDays,
    responsible: seed.responsible,
    payments,
    distributions,
  };
}

export function getSupplies(): Supply[] {
  return SUPPLY_SEEDS.map((seed) => assembleSupply(seedToInput(seed)));
}

export function getFactories(): Factory[] {
  return computeFactories(MOCK_FACTORIES, getSupplies());
}

export function getFulfillment(): FulfillmentSummary {
  return computeFulfillment(getSupplies());
}

// ─── Финансы ────────────────────────────────────────────────────────────────

export function getFinanceRows(): FinanceRow[] {
  const rnd = mulberry32(11);
  const months = ["Февраль 2026", "Март 2026", "Апрель 2026", "Май 2026", "Июнь 2026"];
  return months.map((period, i) => {
    const salesRub = Math.round((1650000 + i * 190000) * (0.92 + rnd() * 0.16));
    const commissionRub = Math.round(salesRub * 0.243);
    const logisticsRub = Math.round(salesRub * 0.078);
    const storageRub = Math.round(salesRub * 0.011);
    const penaltyRub = Math.round(rnd() * 14000);
    const toPayRub = salesRub - commissionRub - logisticsRub - storageRub - penaltyRub;
    const profitRub = Math.round(toPayRub - salesRub * 0.36);
    return { period, salesRub, commissionRub, logisticsRub, storageRub, penaltyRub, toPayRub, profitRub };
  });
}

// ─── Задачи ─────────────────────────────────────────────────────────────────

export function getTasks(): TaskItem[] {
  const base = {
    description: null,
    assigneeId: null,
    createdById: null,
    report: null,
    completedAt: null,
    completedOnTime: null,
  };
  return [
    { ...base, id: "t1", title: "Заполнить план РНП на следующую неделю", status: "open", priority: "urgent", assignee: "Марат Менеджеров", dueDate: "2026-07-10", productLabel: null },
    { ...base, id: "t2", title: "Обновить фото карточки — Кимоно", status: "in_progress", priority: "high", assignee: "Алия Сатпаева", dueDate: "2026-07-08", productLabel: "Кимоно" },
    { ...base, id: "t3", title: "Проверить ставки рекламы (ДРР выше 12%)", status: "open", priority: "high", assignee: "Марат Менеджеров", dueDate: "2026-07-07", productLabel: "костюм_гипюр_айвори" },
    { ...base, id: "t4", title: "Отгрузка на Коледино — 120 шт", status: "in_progress", priority: "normal", assignee: "Алия Сатпаева", dueDate: "2026-07-11", productLabel: "Рубашка" },
    { ...base, id: "t5", title: "Пересчитать себестоимость после новой закупки ткани", status: "open", priority: "normal", assignee: "Марат Менеджеров", dueDate: null, productLabel: null },
    { ...base, id: "t6", title: "Ответить на отзывы за неделю", status: "done", priority: "low", assignee: "Алия Сатпаева", dueDate: "2026-07-04", productLabel: null, report: "Обработала 34 отзыва: 28 положительных, 6 с претензией к размеру — передала в контент правку размерной сетки.", completedAt: "2026-07-04T17:40:00Z", completedOnTime: true },
    { ...base, id: "t7", title: "Согласовать бюджет рекламы на июль", status: "done", priority: "high", assignee: "Айгерим Директорова", dueDate: "2026-07-01", productLabel: null, report: "Бюджет утверждён: 450 000 ₽, приоритет — топ-5 SKU по марже.", completedAt: "2026-07-01T12:10:00Z", completedOnTime: true },
  ];
}

// ─── Команда ────────────────────────────────────────────────────────────────

export function getTeam(): TeamMember[] {
  return [
    { id: "u1", name: "Айгерим Директорова", email: "director@demo.wbcrm", role: "owner", joinedAt: "2026-01-15" },
    { id: "u2", name: "Марат Менеджеров", email: "manager@demo.wbcrm", role: "manager", joinedAt: "2026-02-01" },
    { id: "u3", name: "Алия Сатпаева", email: "aliya@demo.wbcrm", role: "manager", joinedAt: "2026-02-20" },
    { id: "u4", name: "Данияр Аналитиков", email: "daniyar@demo.wbcrm", role: "analyst", joinedAt: "2026-03-12" },
    { id: "u5", name: "Гость Инвесторов", email: "guest@demo.wbcrm", role: "viewer", joinedAt: "2026-05-03" },
  ];
}

// ─── Интеграции ─────────────────────────────────────────────────────────────

export function getIntegrations(): IntegrationStatus[] {
  return [
    {
      provider: "wb",
      title: "Wildberries API",
      status: "pending",
      hint: "Ожидает JWT-токен селлера (ЛК WB → Настройки → Доступ к API). Хранится в Supabase Vault.",
      scopes: ["Статистика", "Аналитика", "Контент", "Продвижение", "Финансы"],
      lastSyncAt: null,
    },
    {
      provider: "claude",
      title: "Claude API (AI-аналитика)",
      status: "pending",
      hint: "Ключ платформы задаётся в ANTHROPIC_API_KEY; пользовательский ключ — через Vault.",
      scopes: ["claude-sonnet-5", "claude-opus-4-8"],
      lastSyncAt: null,
    },
    {
      provider: "telegram",
      title: "Telegram-бот",
      status: "pending",
      hint: "Токен бота (BotFather) + webhook на Edge Function. Уведомления и задачи.",
      scopes: ["Задачи", "Уведомления", "Сводки"],
      lastSyncAt: null,
    },
  ];
}

// ─── Тарифы ─────────────────────────────────────────────────────────────────

export function getTariffs(): Tariff[] {
  return [
    { code: "trial", name: "Пробный", priceMonth: 0, maxStores: 1, maxProducts: 50, aiTokensMonth: 100_000, syncIntervalMin: 60, current: true },
    { code: "start", name: "Старт", priceMonth: 1990, maxStores: 1, maxProducts: 200, aiTokensMonth: 500_000, syncIntervalMin: 60, current: false },
    { code: "pro", name: "Про", priceMonth: 4990, maxStores: 3, maxProducts: 1000, aiTokensMonth: 2_000_000, syncIntervalMin: 30, current: false },
    { code: "business", name: "Бизнес", priceMonth: 9990, maxStores: 10, maxProducts: null, aiTokensMonth: 5_000_000, syncIntervalMin: 15, current: false },
  ];
}
