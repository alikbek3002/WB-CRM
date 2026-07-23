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
const cny = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});

export function formatMoney(value: number, currency: string): string {
  switch (currency) {
    case "cny":
      return cny.format(value); // ¥ 1 234
    case "uzs":
      return `${num.format(value)} сум`; // у сума нет ISO-символа
    case "rub":
    default:
      return rub.format(value);
  }
}
