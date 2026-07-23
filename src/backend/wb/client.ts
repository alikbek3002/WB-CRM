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
