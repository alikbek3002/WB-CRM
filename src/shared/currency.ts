// Мультивалюта. ОДНА базовая валюта на всю систему — СОМ (KGS).
//
// ПОЧЕМУ СОМ, А НЕ РУБЛЬ. Юрлицо киргизское: кабинет WB ведёт расчёты в сомах
// (raw_finance_report.currency_name = KGS, wb_balance.currency = KGS), деньги от
// маркетплейса приходят в сомах, зарплаты и аренда платятся в сомах. Раньше
// сводной валютой считался рубль: выручка WB (уже сомы) складывалась с кассой,
// пересчитанной в рубли по курсу 0,93 — две разные валюты в одной строке ОПиУ.
// Теперь всё приводится к сому: выручка кабинета — как есть, «своя» сторона
// (касса, оплаты фабрикам, карго, заявки на выплату) — по курсу из currency_rates.
//
// Исторические имена полей `*_rub` / `*Rub` в БД и типах ОСТАВЛЕНЫ (их сотни, и
// в WB-агрегатах они и раньше держали сомы). Читать их следует как «сумма в
// базовой валюте» — то есть в сомах.
//
// Курсы правят директор и старший менеджер: «Финансы → Валюты» (право
// currency:manage). Значения ниже — только дефолты: на случай пустой таблицы
// currency_rates и демо-режима без БД.

export const BASE_CURRENCY = "kgs" as const;

// Порядок = порядок в селектах и на вкладке «Валюты»: сначала своя валюта,
// потом доллар (в нём считают фабрики и карго), потом остальные.
export const CURRENCY_CODES = ["kgs", "usd", "rub", "cny", "uzs"] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

// Тот же тип под привычным именем: формы и карточки импортируют `Currency`
// из shared/types, доменные модули — отсюда.
export type Currency = CurrencyCode;

export const CURRENCY_SIGN: Record<CurrencyCode, string> = {
  kgs: "сом",
  usd: "$",
  rub: "₽",
  cny: "¥",
  uzs: "сум",
};

export const CURRENCY_NAME: Record<CurrencyCode, string> = {
  kgs: "Сом",
  usd: "Доллар США",
  rub: "Рубль",
  cny: "Юань",
  uzs: "Сум",
};

// Подпись для селектов: знак + название, чтобы «$» не путался с «сом»
export const CURRENCY_LABEL: Record<CurrencyCode, string> = {
  kgs: "сом",
  usd: "$ доллар",
  rub: "₽ рубль",
  cny: "¥ юань",
  uzs: "сум",
};

// Код → сколько сомов стоит одна единица валюты (сом → 1)
export type CurrencyRateMap = Record<string, number>;

// Ориентиры на август 2026. Реальные курсы задаются в интерфейсе и живут в БД —
// эти нужны только чтобы система не делила на ноль до первой правки.
export const DEFAULT_RATES_TO_BASE: Record<CurrencyCode, number> = {
  kgs: 1,
  usd: 87.5,
  rub: 1.1,
  cny: 12.2,
  uzs: 0.0069,
};

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCY_CODES as readonly string[]).includes(value);
}

// Приведение кода к нашему виду: WB отдаёт «KGS», формы — «kgs».
export function normalizeCurrency(value: string | null | undefined): CurrencyCode | null {
  const code = String(value ?? "").trim().toLowerCase();
  return isCurrencyCode(code) ? code : null;
}

// Курс валюты к сому. Неизвестная валюта или битый курс → 1: лучше показать
// сумму «как есть», чем умножить деньги на ноль.
export function rateToBase(currency: string, rates?: CurrencyRateMap | null): number {
  const code = normalizeCurrency(currency);
  if (code === BASE_CURRENCY) return 1;
  const rate = code ? rates?.[code] : undefined;
  if (Number.isFinite(rate) && (rate as number) > 0) return rate as number;
  const fallback = code ? DEFAULT_RATES_TO_BASE[code] : undefined;
  return Number.isFinite(fallback) && (fallback as number) > 0 ? (fallback as number) : 1;
}

// Сумма в базовой валюте (сомах). Округляем до целого: сотые доли сома в
// отчётности не значат ничего, а дробные хвосты ломают сверку сумм.
export function toBase(amount: number, currency: string, rates?: CurrencyRateMap | null): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * rateToBase(currency, rates));
}

// Полная карта курсов (все коды заполнены) — для клиентских компонентов,
// которые считают предпросмотр «≈ N сом» без обращения к серверу.
export function fullRateMap(rates?: CurrencyRateMap | null): Record<CurrencyCode, number> {
  const out = { ...DEFAULT_RATES_TO_BASE };
  for (const code of CURRENCY_CODES) {
    const rate = rates?.[code];
    if (Number.isFinite(rate) && (rate as number) > 0) out[code] = rate as number;
  }
  out[BASE_CURRENCY] = 1;
  return out;
}
