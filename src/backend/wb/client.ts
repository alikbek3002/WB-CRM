// Клиент Wildberries API (только сервер). Токен — WB_API_TOKEN из окружения,
// в клиентский код и БД в открытом виде не попадает (Vault — отдельной фазой).
//
// Хосты по категориям токена: content / statistics / discounts-prices / common.
// Лимиты: statistics — 1 запрос/мин на эндпоинт; content — 100 запросов/мин.
// На 429 — ретрай с ожиданием (Retry-After или 20 с), до 3 попыток.

export function getWbToken(): string | null {
  const t = process.env.WB_API_TOKEN?.trim();
  return t ? t : null;
}

export class WbApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "WbApiError";
  }
}

async function wbFetch<T>(
  url: string,
  token: string,
  init?: RequestInit,
  timeoutMs = 180_000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.status === 429 && attempt < 4) {
        // WB отдаёт X-Ratelimit-Retry (сек); statistics-эндпоинты — 1 запрос/мин
        const wait =
          Number(res.headers.get("x-ratelimit-retry")) ||
          Number(res.headers.get("retry-after")) ||
          61;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new WbApiError(
          `WB API ${res.status}: ${body.slice(0, 300)}`,
          res.status,
          url,
        );
      }
      // 204 — данных нет (finance-api так завершает пагинацию отчёта)
      if (res.status === 204) return null as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Общее: информация о продавце ────────────────────────────────────────────

export type WbSellerInfo = { name: string; sid: string; tradeMark: string };

export function fetchSellerInfo(token: string): Promise<WbSellerInfo> {
  return wbFetch<WbSellerInfo>(
    "https://common-api.wildberries.ru/api/v1/seller-info",
    token,
    undefined,
    30_000,
  );
}

// ─── Контент: карточки товаров (фото, описание, размеры) ────────────────────

export type WbCardPhoto = {
  big?: string;
  c246x328?: string;
  c516x688?: string;
  square?: string;
  tm?: string;
};

export type WbCard = {
  nmID: number;
  imtID: number;
  vendorCode: string;
  brand: string;
  title: string;
  description?: string;
  subjectName?: string;
  photos?: WbCardPhoto[];
  sizes?: { chrtID: number; techSize: string; skus: string[] }[];
  updatedAt?: string;
};

type WbCardsResponse = {
  cards: WbCard[];
  cursor: { updatedAt?: string; nmID?: number; total: number };
};

// Все карточки кабинета (пагинация курсором по 100)
export async function fetchAllCards(token: string): Promise<WbCard[]> {
  const all: WbCard[] = [];
  let cursor: { limit: number; updatedAt?: string; nmID?: number } = { limit: 100 };
  for (let page = 0; page < 200; page++) {
    const res = await wbFetch<WbCardsResponse>(
      "https://content-api.wildberries.ru/content/v2/get/cards/list",
      token,
      {
        method: "POST",
        body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }),
      },
      60_000,
    );
    all.push(...(res.cards ?? []));
    if (!res.cards || res.cards.length < cursor.limit) return all;
    cursor = {
      limit: 100,
      updatedAt: res.cursor?.updatedAt,
      nmID: res.cursor?.nmID,
    };
  }
  // Дошли до предохранителя, не встретив последнюю страницу — каталог обрезан
  throw new Error("cards: превышен предел пагинации (20 000 карточек) — выгрузка неполная");
}

// ─── Цены и скидки ───────────────────────────────────────────────────────────

export type WbGoodPrice = {
  nmID: number;
  sizes: { price: number; discountedPrice: number }[];
};

type WbPricesResponse = { data: { listGoods: WbGoodPrice[] } };

export async function fetchPrices(token: string): Promise<Map<number, { price: number; discounted: number }>> {
  const map = new Map<number, { price: number; discounted: number }>();
  const limit = 1000;
  for (let offset = 0; offset < 100_000; offset += limit) {
    const res = await wbFetch<WbPricesResponse>(
      `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=${limit}&offset=${offset}`,
      token,
      undefined,
      60_000,
    );
    const goods = res.data?.listGoods ?? [];
    for (const g of goods) {
      const s = g.sizes?.[0];
      if (s) map.set(g.nmID, { price: s.price, discounted: s.discountedPrice });
    }
    if (goods.length < limit) return map;
  }
  throw new Error("prices: превышен предел пагинации (100 000 позиций) — выгрузка неполная");
}

// ─── Статистика: остатки, заказы, продажи ────────────────────────────────────

// Остатки — актуальный метод warehouse_remains (Seller Analytics, async-отчёт):
// создать задачу → дождаться готовности → скачать. Старый /supplier/stocks
// объявлен deprecated и живёт под жёстким rate-limit.
export type WbRemainRow = {
  nmId: number;
  techSize: string;
  warehouses: { warehouseName: string; quantity: number }[];
};

const ANALYTICS = "https://seller-analytics-api.wildberries.ru";

export async function fetchWarehouseRemains(token: string): Promise<WbRemainRow[]> {
  const created = await wbFetch<{ data: { taskId: string } }>(
    `${ANALYTICS}/api/v1/warehouse_remains?locale=ru&groupByNm=true&groupBySize=true`,
    token,
    undefined,
    30_000,
  );
  const taskId = created.data.taskId;

  // Поллинг готовности отчёта (обычно секунды)
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const st = await wbFetch<{ data: { status: string } }>(
      `${ANALYTICS}/api/v1/warehouse_remains/tasks/${taskId}/status`,
      token,
      undefined,
      15_000,
    );
    if (st.data.status === "done") break;
    if (i === 23) throw new Error("warehouse_remains: отчёт не готов за 2 мин");
  }

  return wbFetch<WbRemainRow[]>(
    `${ANALYTICS}/api/v1/warehouse_remains/tasks/${taskId}/download`,
    token,
    undefined,
    60_000,
  );
}

export type WbOrderRow = {
  srid: string;
  nmId: number;
  date: string; // локальное время МСК без пояса
  lastChangeDate: string;
  priceWithDisc: number;
  finishedPrice: number;
  spp: number;
  warehouseName?: string;
  regionName?: string;
  isCancel: boolean;
};

export function fetchOrders(
  token: string,
  dateFrom: string,
  timeoutMs = 180_000,
): Promise<WbOrderRow[]> {
  return wbFetch<WbOrderRow[]>(
    `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${dateFrom}`,
    token,
    undefined,
    timeoutMs,
  );
}

export type WbSaleRow = {
  srid: string;
  saleID: string; // Sxxx — продажа, Rxxx — возврат
  nmId: number;
  date: string;
  lastChangeDate: string;
  priceWithDisc: number;
  forPay: number;
  spp: number;
  techSize?: string; // размер (42, S, 0 у безразмерных) — для runway по размерам
};

export function fetchSales(
  token: string,
  dateFrom: string,
  timeoutMs = 180_000,
): Promise<WbSaleRow[]> {
  return wbFetch<WbSaleRow[]>(
    `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${dateFrom}`,
    token,
    undefined,
    timeoutMs,
  );
}

// ─── Финансы: отчёт о реализации (детализация к оплате) ──────────────────────
// POST finance-api /sales-reports/detailed — единственный источник фактических
// удержаний WB: комиссия, эквайринг, логистика, хранение, штрафы, приёмка.
// Прежний GET v5/supplier/reportDetailByPeriod WB отключает с 15.07.2026 —
// поля переехали в camelCase, суммы приходят СТРОКАМИ («761.02»).
// Пагинация курсором rrdId: следующий запрос начинается с rrdId последней
// полученной строки, конец данных — ответ 204.
// Лимит finance-api — 1 запрос/мин, поэтому тянем партиями с паузой.

export type WbFinanceRow = {
  reportId: number; // номер еженедельного отчёта (бывш. realizationreport_id)
  dateFrom: string; // период отчёта
  dateTo: string;
  currency?: string;
  rrdId: number;
  nmId?: number;
  docTypeName?: string; // «Продажа» | «Возврат»
  sellerOperName?: string; // «Продажа», «Логистика», «Хранение», «Штраф»…
  quantity?: number;
  retailPrice?: number | string;
  retailAmount?: number | string; // сумма продажи
  retailPriceWithDisc?: number | string;
  ppvzSalesCommission?: number | string; // комиссия WB
  forPay?: number | string; // к перечислению продавцу (бывш. ppvz_for_pay)
  acquiringFee?: number | string; // эквайринг
  deliveryService?: number | string; // логистика в деньгах (deliveryAmount — штуки)
  rebillLogisticCost?: number | string; // возмещение логистики
  paidStorage?: number | string; // хранение (бывш. storage_fee)
  penalty?: number | string;
  paidAcceptance?: number | string; // платная приёмка (бывш. acceptance)
  deduction?: number | string; // прочие удержания
  saleDt?: string;
  rrDate?: string; // дата расчёта — по ней отчёт разбит на периоды (бывш. rr_dt)
};

export function fetchFinanceReport(
  token: string,
  dateFrom: string,
  dateTo: string,
  rrdId = 0,
  limit = 100_000,
  timeoutMs = 180_000,
): Promise<WbFinanceRow[]> {
  return wbFetch<WbFinanceRow[] | null>(
    "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        dateFrom: `${dateFrom}T00:00:00Z`,
        dateTo: `${dateTo}T23:59:59Z`,
        rrdId,
        limit,
      }),
    },
    timeoutMs,
  ).then((r) => r ?? []);
}

// Баланс кабинета: сколько WB ещё должен продавцу (и сколько можно вывести).
// Валюта кабинета может быть не рублёвой (у киргизского юрлица — KGS).
export type WbBalance = { currency: string; current: number; for_withdraw: number };

export function fetchAccountBalance(token: string): Promise<WbBalance> {
  return wbFetch<WbBalance>(
    "https://finance-api.wildberries.ru/api/v1/account/balance",
    token,
    undefined,
    30_000,
  );
}

// ─── Реклама: кампании и расход ──────────────────────────────────────────────

type WbPromotionCount = {
  adverts: { type: number; status: number; count: number; advert_list: { advertId: number; changeTime: string }[] }[];
  all: number;
};

// Список кампаний кабинета. changeTime нужен, чтобы не тянуть статистику по
// кампаниям, которых давно не касались.
export async function fetchAdvertCampaigns(
  token: string,
): Promise<{ advertId: number; status: number; changeTime: string }[]> {
  const res = await wbFetch<WbPromotionCount>(
    "https://advert-api.wildberries.ru/adv/v1/promotion/count",
    token,
    undefined,
    30_000,
  );
  return (res.adverts ?? []).flatMap((group) =>
    (group.advert_list ?? []).map((a) => ({
      advertId: a.advertId,
      status: group.status,
      changeTime: a.changeTime,
    })),
  );
}

// Разбивка дня по товарам: WB отдаёт её внутри площадок (apps[].nms[]).
// Благодаря ей расход раскладывается по артикулам — иначе ДРР по товару не
// посчитать, будет только общая сумма по кампании.
export type WbAdvertNm = {
  nmId: number;
  name?: string;
  views: number;
  clicks: number;
  sum: number;
  atbs: number;
  orders: number;
};

export type WbAdvertDay = {
  date: string;
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  sum: number; // расход
  atbs: number;
  orders: number;
  cr: number;
  apps?: { appType: number; nms?: WbAdvertNm[] }[];
};

export type WbAdvertStat = {
  advertId: number;
  currency?: string;
  views: number;
  clicks: number;
  sum: number;
  orders: number;
  days: WbAdvertDay[];
};

// Статистика кампаний за период. v2 (POST) отключён — работает GET v3 с ids.
// Лимит — 1 запрос/мин, поэтому вызывающая сторона сама делает паузы.
export function fetchAdvertStats(
  token: string,
  advertIds: number[],
  beginDate: string,
  endDate: string,
  timeoutMs = 120_000,
): Promise<WbAdvertStat[]> {
  const url =
    "https://advert-api.wildberries.ru/adv/v3/fullstats" +
    `?ids=${advertIds.join(",")}&beginDate=${beginDate}&endDate=${endDate}`;
  return wbFetch<WbAdvertStat[]>(url, token, undefined, timeoutMs).then((r) => r ?? []);
}

// ─── Поставки FBW (supplies-api) ─────────────────────────────────────────────
// Старый statistics /supplier/incomes удалён WB (404, проверено 2026-08).
// Актуальный источник — Supplies API: POST /supplies (список), затем по каждой
// поставке GET /{id} (склад, статус, стоимость приёмки) и GET /{id}/goods
// (разбивка по товарам). Проверено вживую на кабинете.

const SUPPLIES = "https://supplies-api.wildberries.ru";

export type WbSupplyListItem = {
  supplyID: number | null; // null — черновик (только preorderID)
  preorderID: number | null;
  createDate?: string;
  supplyDate?: string | null;
  factDate?: string | null;
  updatedDate?: string;
  statusID: number;
};

export function fetchWbSupplyList(
  token: string,
  limit = 500,
): Promise<WbSupplyListItem[]> {
  return wbFetch<WbSupplyListItem[]>(
    `${SUPPLIES}/api/v1/supplies`,
    token,
    { method: "POST", body: JSON.stringify({ limit, next: 0 }) },
    60_000,
  ).then((r) => r ?? []);
}

export type WbSupplyDetail = {
  statusID: number;
  createDate?: string;
  supplyDate?: string | null;
  factDate?: string | null;
  updatedDate?: string;
  warehouseName?: string;
  actualWarehouseName?: string;
  acceptanceCost?: number;
  quantity?: number;
  acceptedQuantity?: number;
};

export function fetchWbSupplyDetail(token: string, supplyId: number): Promise<WbSupplyDetail> {
  return wbFetch<WbSupplyDetail>(`${SUPPLIES}/api/v1/supplies/${supplyId}`, token, undefined, 30_000);
}

export type WbSupplyGood = {
  barcode?: string;
  vendorCode?: string;
  nmID: number;
  techSize?: string;
  color?: string;
  quantity?: number;
  acceptedQuantity?: number;
  readyForSaleQuantity?: number;
};

export function fetchWbSupplyGoods(token: string, supplyId: number): Promise<WbSupplyGood[]> {
  return wbFetch<WbSupplyGood[]>(
    `${SUPPLIES}/api/v1/supplies/${supplyId}/goods`,
    token,
    undefined,
    30_000,
  ).then((r) => r ?? []);
}

// ─── Marketplace API: личные склады продавца и остатки FBS ───────────────────
// Токен категории «Маркетплейс». Лимит 300 запросов/мин (всплеск 20) на все
// методы складов/остатков — паузы между складами делает синк.

const MARKETPLACE = "https://marketplace-api.wildberries.ru";

export type WbFbsWarehouse = {
  id: number;
  name: string;
  officeId?: number;
  cargoType?: number;
  deliveryType?: number;
  isDeleting?: boolean;
  isProcessing?: boolean;
};

export function fetchFbsWarehouses(token: string): Promise<WbFbsWarehouse[]> {
  return wbFetch<WbFbsWarehouse[]>(
    `${MARKETPLACE}/api/v3/warehouses`,
    token,
    undefined,
    30_000,
  ).then((r) => r ?? []);
}

// Офисы (пункты приёмки) WB — ЕДИНСТВЕННЫЙ источник городов по API. Личный
// склад продавца ссылается сюда через officeId, поэтому город точки разгрузки
// («Фбс каз» → Ульяновск) берётся отсюда, а не из прозвища подрядчика.
// Проверено вживую 2026-08-13: 200, 77 офисов, 49 городов.
export type WbOffice = {
  id: number;
  name: string;
  city?: string;
  address?: string;
  federalDistrict?: string;
  cargoType?: number;
  deliveryType?: number;
  selected?: boolean;
};

export function fetchWbOffices(token: string): Promise<WbOffice[]> {
  return wbFetch<WbOffice[]>(
    `${MARKETPLACE}/api/v3/offices`,
    token,
    undefined,
    30_000,
  ).then((r) => r ?? []);
}

// Город офиса для справочника разгрузки. У московских точек WB кладёт в city
// не город, а зону: «Москва_Восток», «Москва_Запад-Юг», «Москва_Север»
// (проверено на всех 77 офисах — подчёркивание встречается только у Москвы).
// Без склейки Москва троилась бы в списке «куда разгружаем», а статистика по
// городу разъезжалась на три строки.
export function officeCity(office: WbOffice): string | null {
  const raw = String(office.city ?? "").trim();
  if (!raw) return null;
  return raw.split("_")[0].trim() || raw;
}

// Склады WB, куда можно отгружать поставки FBW («куда» после разбора).
// Токен категории «Поставки». Проверено вживую 2026-08-13: 200, 18 складов.
export type WbFbwWarehouse = {
  ID: number;
  name: string;
  address?: string;
  workTime?: string;
  isActive?: boolean;
  isTransitActive?: boolean;
};

export function fetchFbwWarehouses(token: string): Promise<WbFbwWarehouse[]> {
  return wbFetch<WbFbwWarehouse[]>(
    `${SUPPLIES}/api/v1/warehouses`,
    token,
    undefined,
    30_000,
  ).then((r) => r ?? []);
}

// Остатки склада по chrtID размеров (≤1000 за запрос — чанкует вызывающая
// сторона). Контракт body {chrtIds} и ответа {stocks:[{sku, chrtId, amount}]}
// проверен вживую 2026-08-08 (в старых доках описан body {skus} — на случай
// отката WB синк матчит и по chrtId, и по sku→product_sizes.barcode).
export type WbFbsStockRow = { sku: string; chrtId?: number; amount: number };

export function fetchFbsStocks(
  token: string,
  warehouseId: number,
  chrtIds: number[],
): Promise<WbFbsStockRow[]> {
  return wbFetch<{ stocks: WbFbsStockRow[] }>(
    `${MARKETPLACE}/api/v3/stocks/${warehouseId}`,
    token,
    { method: "POST", body: JSON.stringify({ chrtIds }) },
    30_000,
  ).then((r) => r?.stocks ?? []);
}

// ─── Seller Analytics: async-отчёты (платное хранение, платная приёмка) ─────
// Одинаковый каркас с warehouse_remains: создать задачу → поллинг → скачать.
// Лимит: ~1 создание задачи в минуту на отчёт — паузы делает вызывающая сторона.

async function fetchAnalyticsTaskReport<T>(
  token: string,
  path: string,
  query: string,
): Promise<T[]> {
  const created = await wbFetch<{ data: { taskId: string } }>(
    `${ANALYTICS}/api/v1/${path}?${query}`,
    token,
    undefined,
    30_000,
  );
  const taskId = created.data.taskId;

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const st = await wbFetch<{ data: { status: string } }>(
      `${ANALYTICS}/api/v1/${path}/tasks/${taskId}/status`,
      token,
      undefined,
      15_000,
    );
    if (st.data.status === "done") break;
    if (i === 23) throw new Error(`${path}: отчёт не готов за 2 мин`);
  }

  // Пустой отчёт WB отдаёт 200 без тела → res.json() кидает SyntaxError
  const rows = await wbFetch<T[]>(
    `${ANALYTICS}/api/v1/${path}/tasks/${taskId}/download`,
    token,
    undefined,
    120_000,
  ).catch((e) => {
    if (e instanceof SyntaxError) return [] as T[];
    throw e;
  });
  return rows ?? [];
}

// Платное хранение по товару/дню/складу. Окно задачи — максимум 8 дней.
export type WbStorageRow = {
  date: string;
  warehouse?: string;
  warehousePrice?: number; // стоимость хранения за день, в валюте кабинета (сом)
  barcodesCount?: number;
  volume?: number;
  nmId: number;
  chrtId?: number;
  size?: string;
  barcode?: string;
};

export function fetchPaidStorage(
  token: string,
  dateFrom: string,
  dateTo: string,
): Promise<WbStorageRow[]> {
  return fetchAnalyticsTaskReport<WbStorageRow>(
    token,
    "paid_storage",
    `dateFrom=${dateFrom}&dateTo=${dateTo}`,
  );
}

// Платная приёмка по поставкам. Окно задачи — максимум 31 день.
export type WbAcceptanceRow = {
  incomeId: number;
  nmID: number;
  giCreateDate?: string;
  count?: number;
  total?: number; // стоимость приёмки, в валюте кабинета (сом)
  subjectName?: string;
};

export function fetchAcceptanceReport(
  token: string,
  dateFrom: string,
  dateTo: string,
): Promise<WbAcceptanceRow[]> {
  return fetchAnalyticsTaskReport<WbAcceptanceRow>(
    token,
    "acceptance_report",
    `dateFrom=${dateFrom}&dateTo=${dateTo}`,
  );
}

// ─── Seller Analytics: воронка продаж по дням (sales-funnel v3) ───────────────
// Старый nm-report удалён WB (404, проверено 2026-08); актуальный метод —
// /api/analytics/v3/sales-funnel/products/history: {selectedPeriod:{start,end},
// nmIds:[…]} → [{product:{nmId…}, history:[{date, openCount, cartCount…}]}].
// Лимиты консервативно как у nm-report: ≤20 nmId, окно ≤7 дней, паузы 20+ с.

export type WbFunnelHistoryDay = {
  date: string;
  openCount?: number; // переходы в карточку
  cartCount?: number; // корзина
  orderCount?: number;
  orderSum?: number;
  buyoutCount?: number;
  buyoutSum?: number;
  buyoutPercent?: number;
  addToCartConversion?: number;
  cartToOrderConversion?: number;
};

export type WbFunnelHistoryRow = {
  product?: { nmId: number; title?: string; vendorCode?: string };
  history?: WbFunnelHistoryDay[];
};

export async function fetchSalesFunnelHistory(
  token: string,
  nmIds: number[],
  start: string,
  end: string,
  timeoutMs = 120_000, // 20 nmId × 7 дней бывает медленным — 60 с не хватало
): Promise<WbFunnelHistoryRow[]> {
  const res = await wbFetch<WbFunnelHistoryRow[]>(
    `${ANALYTICS}/api/analytics/v3/sales-funnel/products/history`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ selectedPeriod: { start, end }, nmIds }),
    },
    timeoutMs,
  );
  return res ?? [];
}

// ─── Тарифы WB (common-api): комиссия по категориям, логистика/хранение ─────

export type WbCommissionTariff = {
  subjectID: number;
  subjectName?: string;
  parentID?: number;
  parentName?: string;
  kgvpMarketplace?: number; // FBW, %
  kgvpSupplier?: number; // FBS, %
  kgvpSupplierExpress?: number;
  paidStorageKgvp?: number;
};

export async function fetchCommissionTariffs(token: string): Promise<WbCommissionTariff[]> {
  const res = await wbFetch<{ report?: WbCommissionTariff[] }>(
    "https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru",
    token,
    undefined,
    30_000,
  );
  return res.report ?? [];
}

// Тарифы отдаются строками с запятой («48,5») — приводим к числу
function numComma(v: unknown): number {
  const n = Number(String(v ?? "0").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export type WbBoxTariff = {
  warehouseName: string;
  deliveryBase: number;
  deliveryLiter: number;
  storageBase: number;
  storageLiter: number;
  exprPct: number;
  dtFrom: string | null;
  dtTill: string | null;
};

export async function fetchBoxTariffs(token: string, date: string): Promise<WbBoxTariff[]> {
  const res = await wbFetch<{
    response?: {
      data?: {
        dtNextBox?: string;
        dtTillMax?: string;
        warehouseList?: Record<string, unknown>[];
      };
    };
  }>(
    `https://common-api.wildberries.ru/api/v1/tariffs/box?date=${date}`,
    token,
    undefined,
    30_000,
  );
  const data = res.response?.data;
  return (data?.warehouseList ?? [])
    .filter((w) => w.warehouseName)
    .map((w) => ({
      warehouseName: String(w.warehouseName),
      deliveryBase: numComma(w.boxDeliveryBase),
      deliveryLiter: numComma(w.boxDeliveryLiter),
      storageBase: numComma(w.boxStorageBase),
      storageLiter: numComma(w.boxStorageLiter),
      exprPct: numComma(w.boxDeliveryCoefExpr ?? w.boxDeliveryAndStorageExpr),
      dtFrom: data?.dtNextBox ? String(data.dtNextBox).slice(0, 10) : null,
      dtTill: data?.dtTillMax ? String(data.dtTillMax).slice(0, 10) : null,
    }));
}

// ─── Скоупы токена (для карточки интеграции) ─────────────────────────────────

const SCOPE_BITS: Record<number, string> = {
  1: "Контент",
  2: "Аналитика",
  3: "Цены и скидки",
  4: "Маркетплейс",
  5: "Статистика",
  6: "Продвижение",
  7: "Вопросы и отзывы",
  9: "Чат с покупателями",
  10: "Поставки",
  11: "Возвраты",
  12: "Документы",
  30: "Только чтение",
};

// Скоупы и срок действия из JWT-полезной нагрузки (без проверки подписи —
// подпись проверяет сам WB; нам нужны только метаданные для отображения).
export function decodeTokenMeta(token: string): { scopes: string[]; expiresAt: Date | null } {
  try {
    const payload = token.split(".")[1];
    const pad = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const data = JSON.parse(Buffer.from(pad, "base64url").toString()) as {
      s?: number;
      exp?: number;
    };
    const scopes: string[] = [];
    const mask = data.s ?? 0;
    for (const [bit, name] of Object.entries(SCOPE_BITS)) {
      if (mask & (1 << Number(bit))) scopes.push(name);
    }
    return {
      scopes,
      expiresAt: data.exp ? new Date(data.exp * 1000) : null,
    };
  } catch {
    return { scopes: [], expiresAt: null };
  }
}
