const rub = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const num = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function formatRub(value: number): string {
  return rub.format(value);
}

export function formatNumber(value: number): string {
  return num.format(value);
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

// Мультивалюта для цепочки поставок: ¥ (юань), ₽ (рубль), сум (Узбекистан).
// Валюта кабинета WB. Юрлицо может быть не российским (у киргизского продавца
// отчёт приходит в сомах), и подписывать такие суммы рублём — врать в отчёте.
const CURRENCY_SIGN: Record<string, string> = {
  RUB: "₽",
  KGS: "сом",
  KZT: "₸",
  BYN: "Br",
  UZS: "сум",
  CNY: "¥",
  USD: "$",
};

export function currencySign(currency = "RUB"): string {
  return CURRENCY_SIGN[currency.toUpperCase()] ?? currency.toUpperCase();
}

// Сумма в валюте кабинета: «1 234 567 сом», «1 234 567 ₽»
export function formatAmount(value: number, currency = "RUB"): string {
  return `${num.format(Math.round(value))} ${currencySign(currency)}`;
}

// Компактно для осей и плотных мест: «220 млн», «1,5 млн», «830 тыс».
// Дробную часть показываем только там, где она что-то значит: «220,0 млн» на
// оси — визуальный шум.
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10_000_000_000) return `${Math.round(value / 1_000_000_000)} млрд`;
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(".", ",")} млрд`;
  if (abs >= 10_000_000) return `${Math.round(value / 1_000_000)} млн`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".", ",")} млн`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)} тыс`;
  return String(Math.round(value));
}

// Компактная сумма в валюте кабинета: «25,3 млрд сом», «138 млн ₽»
export function formatCompactAmount(value: number, currency = "RUB"): string {
  return `${formatCompact(value)} ${currencySign(currency)}`;
}

export function formatMoney(value: number, currency: string): string {
  switch (currency) {
    case "cny":
      return `${num.format(value)} ¥`;
    case "uzs":
      return `${num.format(value)} сум`; // у сума нет ISO-символа
    case "kgs":
      return `${num.format(value)} сом`;
    case "rub":
    default:
      return rub.format(value);
  }
}
