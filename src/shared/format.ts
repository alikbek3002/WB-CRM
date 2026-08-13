import { BASE_CURRENCY, CURRENCY_SIGN, normalizeCurrency, type Currency } from "./currency";

const num = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

// Базовая валюта компании — сом (см. shared/currency.ts). Все сводные суммы
// (выручка кабинета, касса, расходы, себестоимость, долги фабрикам) показываем
// в ней: до этого суммы в сомах подписывались рублём и врали в отчёте.
export function formatSom(value: number): string {
  return `${num.format(Math.round(value))} сом`;
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

// Знак валюты. Принимает и наш код («usd»), и ISO из ответа WB («KGS»).
export function currencySign(currency: string = BASE_CURRENCY): string {
  const code = normalizeCurrency(currency);
  return code ? CURRENCY_SIGN[code] : currency.toUpperCase();
}

// Сумма в произвольной валюте: «1 234 567 сом», «12 500 $», «18 000 ¥».
export function formatAmount(value: number, currency: string = BASE_CURRENCY): string {
  return `${num.format(Math.round(value))} ${currencySign(currency)}`;
}

// То же, но с типизированным кодом валюты — для форм и карточек, где валюта
// выбрана пользователем (оплаты поставок, счета кассы, заявки на выплату).
export function formatMoney(value: number, currency: Currency): string {
  return formatAmount(value, currency);
}

// Курс валюты к сому: «87,5», «0,0069». Мелкие курсы (сум) при округлении до
// целого превратились бы в ноль — знаков после запятой даём по величине курса.
export function formatRate(rate: number): string {
  const digits = rate >= 100 ? 2 : rate >= 1 ? 4 : 6;
  return rate.toLocaleString("ru-RU", { maximumFractionDigits: digits });
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

// Компактная сумма в валюте: «25,3 млрд сом», «138 млн ₽»
export function formatCompactAmount(value: number, currency: string = BASE_CURRENCY): string {
  return `${formatCompact(value)} ${currencySign(currency)}`;
}
