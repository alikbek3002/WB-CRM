import { revalidateTag } from "next/cache";
import { SESSION_TAG, WB_DATA_TAG, type WbScope } from "./index";

// Сброс кэша чтения (см. cachedRead в ./index). Вызывать в API-роутах и Server
// Actions ПОСЛЕ успешной записи в БД — тогда следующий рендер/refresh страницы
// возьмёт свежие данные, а не закэшированные. Вызов из обычного RSC-рендера
// недопустим (Next бросит ошибку) — только из мутационного контекста.
//
// ПОЧЕМУ СО СПИСКОМ ОБЛАСТЕЙ. Раньше любая мутация звала revalidateTag(WB_DATA_TAG)
// и выбрасывала ВЕСЬ кэш — все 20+ геттеров разом. Закрыл одну задачу — и товары,
// остатки, РНП, ОПиУ, экономика снова читались из Supabase «на холодную».
// Замеры показали цену такого промаха: тёплый кэш 3–9 мс, холодный 4–9 с.
// Именно отсюда бралось «переключаю вкладку — грузит 4–5 секунд».
//
// Теперь мутация сбрасывает только то, на что реально влияет.
// Без аргументов — полный сброс (синк WB, ручной сброс): там меняется всё.
export function invalidateWbData(...scopes: WbScope[]): void {
  if (scopes.length === 0) {
    revalidateTag(WB_DATA_TAG);
    revalidateTag(SESSION_TAG); // полный сброс = вместе с составом команды
    return;
  }
  for (const scope of new Set(scopes)) {
    revalidateTag(`${WB_DATA_TAG}:${scope}`);
  }
}

// ─── Готовые наборы областей ──────────────────────────────────────────────────
// Деньги живут в одной книге cash_tx: проводка меняет кассу, расходы, выплаты и
// ОПиУ одновременно — сбрасываем их вместе, чтобы цифры не разъезжались.
export const MONEY_SCOPES: WbScope[] = ["cash", "expenses", "payroll", "pnl"];

// Курс валюты — множитель под всеми суммами: касса, расходы, ОПиУ, долги
// фабрикам, себестоимость партий и сводка фул-фирмы считаются через него.
// Правка курса обязана сбросить их все, иначе на экранах будут числа по старому
// курсу рядом с числами по новому.
export const CURRENCY_SCOPES: WbScope[] = [
  "currency-rates",
  "cash",
  "expenses",
  "payroll",
  "pnl",
  "supplies",
  "factories",
  "fulfillment",
  "fulfillment-partners",
  "products",
  "unit-econ",
];

// Товар/себестоимость: список товаров, РНП и вся экономика считаются от него.
export const PRODUCT_SCOPES: WbScope[] = [
  "products",
  "rnp",
  "unit-econ",
  "pnl",
  "stocks-overview",
];

// Поставки меняют «в пути» у товаров, остатки складов и сводку фул-фирмы
// (стадии разбора и разрез по городам разгрузки живут там же).
export const SUPPLY_SCOPES: WbScope[] = [
  "supplies",
  "products",
  "stocks-overview",
  "wb-incomes",
  "fulfillment",
];
