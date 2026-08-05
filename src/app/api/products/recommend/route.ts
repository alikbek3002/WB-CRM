import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import type { ProductFunnel, ProductRecommendation } from "@/shared/types";

export const runtime = "nodejs";

// Разбор товара ИИ: почему он слабый или хороший и что конкретно чинить —
// фото, цену, описание, размерный ряд, рекламу или поставку.
//
// Ключевое здесь — ВОРОНКА карточки (raw_funnel_daily), она и отвечает на
// «почему»: провал показ→корзина означает, что карточку смотрят, но она не
// цепляет (фото/цена/заголовок); провал корзина→заказ — отложили и передумали
// (чаще всего цена); низкий выкуп — заказали и вернули (описание не совпало
// с реальностью, размерная сетка врёт). Без этих цифр разбор сводился бы
// к пересказу остатков, что и было раньше.
//
// Реально через Claude при наличии ANTHROPIC_API_KEY (structured output, кэш
// в ai_insights); иначе — детерминированная эвристика. Модель — claude-sonnet-5.
const MODEL = "claude-sonnet-5";

const sizeSchema = z.object({
  size: z.string(),
  onStock: z.number(),
  inTransit: z.number(),
});

const metricsSchema = z.object({
  productId: z.string(),
  nmId: z.number().optional(),
  title: z.string(),
  status: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  isWeak: z.boolean().optional(),

  // Продажи и склад
  salesRank30d: z.number(),
  avgDailySales: z.number(),
  daysOfCover: z.number().nullable(),
  stockQty: z.number(),
  inTransitToMoscow: z.number(),

  // Цена и экономика
  priceWb: z.number().nullable().optional(),
  priceDiscountedWb: z.number().nullable().optional(),
  costPrice: z.number().optional(),
  marginPct: z.number().nullable().optional(),
  drrPct: z.number().nullable().optional(),
  profitPerUnitRub: z.number().nullable().optional(),

  // Наполнение карточки — по нему видно, что улучшать в контенте
  photosCount: z.number().optional(),
  descriptionLength: z.number().optional(),

  // Размерный ряд
  sizes: z.array(sizeSchema).max(40).optional(),

  // С чем сравнивать: медианы по каталогу этого же продавца. Сравнение
  // с собственным каталогом честнее выдуманных «средних по рынку».
  catalog: z
    .object({
      medianSales30d: z.number(),
      medianPrice: z.number().nullable(),
      products: z.number(),
    })
    .optional(),
});
type Metrics = z.infer<typeof metricsSchema>;

// ─── Воронка карточки (серверный запрос, клиенту эти данные не нужны) ────────

async function loadFunnel(nmId: number | undefined): Promise<ProductFunnel | null> {
  const admin = getSupabaseAdmin();
  if (!admin || !nmId) return null;

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const { data, error } = await admin
    .from("raw_funnel_daily")
    .select("open_card_count, add_to_cart_count, orders_count, buyouts_count, stat_date")
    .eq("store_id", DEMO_STORE_ID)
    .eq("nm_id", nmId)
    .gte("stat_date", since.toLocaleDateString("sv"))
    .limit(90);
  if (error || !data?.length) return null;

  let opens = 0, carts = 0, orders = 0, buyouts = 0;
  for (const r of data) {
    opens += Number(r.open_card_count ?? 0);
    carts += Number(r.add_to_cart_count ?? 0);
    orders += Number(r.orders_count ?? 0);
    buyouts += Number(r.buyouts_count ?? 0);
  }
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  return {
    days: data.length,
    opens,
    carts,
    orders,
    buyouts,
    cartRate: pct(carts, opens),
    orderRate: pct(orders, carts),
    buyoutRate: pct(buyouts, orders),
  };
}

// ─── Детерминированная эвристика (fallback без ключа) ─────────────────────────

function heuristic(m: Metrics, f: ProductFunnel | null): ProductRecommendation {
  const problems: ProductRecommendation["problems"] = [];
  const recs: ProductRecommendation["recommendations"] = [];
  const cover = m.daysOfCover;

  // 1) Воронка — где именно теряем покупателя
  if (f && f.opens > 300) {
    if (f.cartRate < 3) {
      problems.push({
        metric: "Показ → корзина",
        severity: "high",
        reason: `Карточку открыли ${f.opens} раз, в корзину положили только ${f.carts} (${f.cartRate}%). Смотрят, но не цепляет — обычно это главное фото, цена или заголовок.`,
      });
      recs.push({
        area: "photo",
        action: "Переснять главное фото: крупный план товара, читаемый инфографикой размер и состав",
        impact: "Прямо влияет на переход из показа в корзину",
        priority: 1,
      });
      recs.push({
        area: "price",
        action: "Сверить цену с конкурентами в выдаче по своему запросу",
        impact: "Цена выше рынка гасит конверсию даже при хорошем фото",
        priority: 2,
      });
    }
    if (f.orderRate > 0 && f.orderRate < 20) {
      problems.push({
        metric: "Корзина → заказ",
        severity: "medium",
        reason: `Из ${f.carts} корзин заказом стали ${f.orders} (${f.orderRate}%). Товар откладывают и не покупают — чаще всего вопрос цены или условий доставки.`,
      });
      recs.push({
        area: "price",
        action: "Протестировать скидку или промокод на 5–10%",
        impact: "Догоняет тех, кто отложил товар в корзину",
        priority: 2,
      });
    }
    if (f.orders > 30 && f.buyoutRate < 40) {
      problems.push({
        metric: "Выкуп",
        severity: "high",
        reason: `Выкупают ${f.buyoutRate}% заказов (${f.buyouts} из ${f.orders}). Заказывают и возвращают — обычно описание или размерная сетка не совпадают с реальностью.`,
      });
      recs.push({
        area: "description",
        action: "Уточнить описание: состав, плотность ткани, замеры по каждому размеру",
        impact: "Меньше возвратов — возвраты съедают логистику дважды",
        priority: 1,
      });
    }
  }

  // 2) Наполнение карточки
  if ((m.photosCount ?? 0) < 4) {
    problems.push({
      metric: "Фото",
      severity: (m.photosCount ?? 0) <= 1 ? "high" : "medium",
      reason: `В карточке ${m.photosCount ?? 0} фото — покупателю не хватает ракурсов, чтобы решиться.`,
    });
    recs.push({
      area: "photo",
      action: "Добавить фото до 6–8: общий план, детали ткани, посадка на модели, инфографика",
      impact: "Больше фото — выше конверсия и меньше возвратов",
      priority: 2,
    });
  }
  if ((m.descriptionLength ?? 0) < 200) {
    problems.push({
      metric: "Описание",
      severity: "medium",
      reason: `Описание короткое (${m.descriptionLength ?? 0} симв.) — теряются поисковые запросы и ответы на вопросы покупателя.`,
    });
    recs.push({
      area: "description",
      action: "Расширить описание до 600–1200 символов с ключевыми запросами и замерами",
      impact: "Рост показов в поиске и меньше возвратов",
      priority: 2,
    });
  }

  // 3) Размерный ряд
  const sizes = m.sizes ?? [];
  const gone = sizes.filter((s) => s.onStock === 0);
  if (sizes.length > 0 && gone.length > 0) {
    const share = Math.round((gone.length / sizes.length) * 100);
    problems.push({
      metric: "Размеры",
      severity: share >= 50 ? "high" : "medium",
      reason: `Нет в наличии ${gone.length} из ${sizes.length} размеров (${gone.map((s) => s.size).join(", ")}). Спрос на них уходит конкурентам, а карточка теряет позиции.`,
    });
    recs.push({
      area: "sizes",
      action: `Допоставить вымытые размеры: ${gone.map((s) => s.size).join(", ")}`,
      impact: "Возврат потерянного спроса по ходовым размерам",
      priority: 1,
    });
  }

  // 4) Склад
  if (cover !== null && cover < 14 && m.inTransitToMoscow === 0) {
    problems.push({
      metric: "Остаток",
      severity: "high",
      reason: `Запаса ~${cover} дн, в пути ничего нет — риск уйти в ноль.`,
    });
    recs.push({
      area: "supply",
      action: "Срочно оформить поставку на фабрике (отшивка + карго)",
      impact: "Избежать потери позиций и продаж из-за нуля остатков",
      priority: 1,
    });
  } else if (cover !== null && cover > 120) {
    problems.push({
      metric: "Оборачиваемость",
      severity: "medium",
      reason: `Запаса на ~${cover} дн — деньги заморожены, растёт платное хранение.`,
    });
    recs.push({
      area: "price",
      action: "Разогнать продажи скидкой/раздачами и приостановить закупки",
      impact: "Ускорить оборачиваемость, снизить хранение",
      priority: 3,
    });
  }

  // 5) Продажи против собственного каталога
  const median = m.catalog?.medianSales30d ?? 0;
  if (median > 0 && m.salesRank30d < median / 2) {
    problems.push({
      metric: "Продажи",
      severity: "medium",
      reason: `${m.salesRank30d} продаж за 30 дней против медианы ${median} по вашему каталогу — товар отстаёт от собственных середняков.`,
    });
  }

  // 6) Реклама
  if (m.drrPct !== null && m.drrPct !== undefined && m.drrPct > 15) {
    problems.push({
      metric: "ДРР",
      severity: m.drrPct > 25 ? "high" : "medium",
      reason: `Реклама съедает ${m.drrPct}% выручки — товар держится на платном трафике.`,
    });
    recs.push({
      area: "ads",
      action: "Срезать ставки и убрать неэффективные фразы; сначала починить карточку",
      impact: "Реклама на слабую карточку сжигает бюджет",
      priority: 2,
    });
  }

  const high = problems.filter((p) => p.severity === "high").length;
  const verdict: ProductRecommendation["verdict"] =
    high > 0 || m.isWeak ? "weak" : problems.length > 0 ? "ok" : "strong";

  if (recs.length === 0) {
    recs.push({
      area: "other",
      action: "Показатели в норме — держать текущую стратегию и следить за остатком",
      impact: "Стабильные продажи",
      priority: 3,
    });
  }

  const summary =
    problems.length === 0
      ? `«${m.title}» работает ровно: критичных проблем по карточке и остаткам не видно.`
      : `«${m.title}»: слабые места — ${problems.map((p) => p.metric.toLowerCase()).join(", ")}.`;

  return {
    productId: m.productId,
    source: "heuristic",
    verdict,
    summary,
    problems,
    recommendations: recs.sort((a, b) => a.priority - b.priority),
    funnel: f,
  };
}

// ─── Claude ───────────────────────────────────────────────────────────────────

const ANALYST_SYSTEM = `Ты — аналитик маркетплейса Wildberries. Тебе дают данные по ОДНОМУ товару
продавца. Ответь на два вопроса: почему товар слабый (или почему он хороший) и что конкретно
сделать, чтобы продавать больше.

Как читать воронку (главный источник ответа «почему»):
- показ → корзина (cartRate): карточку открывают, но не кладут в корзину → не цепляет
  главное фото, цена выше ожидания или заголовок не тот. Это проблема КАРТОЧКИ.
- корзина → заказ (orderRate): отложили и не купили → почти всегда цена или условия.
- выкуп (buyoutRate): заказали и вернули → описание/размерная сетка не совпали
  с реальностью, вопросы к замерам и составу.
Если воронки нет (funnel = null) — не выдумывай её, опирайся на остальное.

Что ещё учитывать: наполнение карточки (photosCount, descriptionLength), дыры в размерном
ряду (sizes с onStock = 0 — вымытые размеры, спрос по ним уходит), запас (daysOfCover),
экономику (marginPct, drrPct) и сравнение с медианой каталога самого продавца (catalog).

Правила:
- Пиши по-русски, конкретно, без воды и без общих слов вроде «улучшить карточку».
- В поле metric пиши КОРОТКОЕ РУССКОЕ название (2–3 слова), как подписал бы его
  человек в интерфейсе: «Показ → корзина», «Выкуп», «Размеры», «Остаток», «ДРР».
  Не подставляй туда имена полей из входного JSON (daysOfCover, buyoutRate и т.п.).
- Каждый совет привязывай к области: photo, price, description, sizes, ads, supply, other.
- Не выдумывай цифры, которых нет во входных данных.
- Если товар в порядке — так и скажи (verdict: strong) и не придумывай проблемы.
- 2–5 советов, самый важный первым (priority 1).
Верни строго JSON по схеме.`;

async function viaClaude(
  m: Metrics,
  f: ProductFunnel | null,
  apiKey: string,
): Promise<ProductRecommendation | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: { type: "string", enum: ["strong", "ok", "weak"] },
        summary: { type: "string" },
        problems: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              metric: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              reason: { type: "string" },
            },
            required: ["metric", "severity", "reason"],
          },
        },
        recommendations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              area: {
                type: "string",
                enum: ["photo", "price", "description", "sizes", "ads", "supply", "other"],
              },
              action: { type: "string" },
              impact: { type: "string" },
              priority: { type: "integer" },
            },
            required: ["area", "action", "impact", "priority"],
          },
        },
      },
      required: ["verdict", "summary", "problems", "recommendations"],
    };

    const res = await client.messages.create({
      model: MODEL,
      // ВАЖНО: у claude-sonnet-5 adaptive-размышление включено, когда поле
      // thinking не задано, а max_tokens ограничивает размышление и ответ
      // ВМЕСТЕ. При тесном лимите ответ обрывается на середине JSON. Здесь
      // задача — разбор по фиксированной схеме, глубокое размышление не нужно:
      // effort "low" держит ~10 с и ~750 токенов, запас max_tokens — от обрыва.
      max_tokens: 3000,
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: ANALYST_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: JSON.stringify({ ...m, funnel: f }) }],
    });

    // Отказ модели и обрыв по лимиту — не ошибка запроса, но и не результат:
    // молча откатываемся на эвристику, иначе JSON.parse упадёт на огрызке.
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      console.error(`[products/recommend] Claude остановился: ${res.stop_reason}`);
      return null;
    }

    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    const parsed = JSON.parse(text.text) as Omit<
      ProductRecommendation,
      "productId" | "source" | "funnel"
    >;
    return { productId: m.productId, source: "claude", ...parsed, funnel: f };
  } catch (err) {
    console.error("[products/recommend] Claude failed, откат на эвристику:", err);
    return null;
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = metricsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const m = parsed.data;
  const funnel = await loadFunnel(m.nmId);

  const promptHash = createHash("sha256")
    .update(`${MODEL}:v2:${JSON.stringify(m)}:${JSON.stringify(funnel)}`)
    .digest("hex")
    .slice(0, 32);
  const admin = getSupabaseAdmin();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Кэш ai_insights. Проверяем verdict: записи старого формата (без разбора по
  // областям) переиспользовать нельзя — интерфейс их уже не покажет.
  if (admin && apiKey) {
    const { data: cached } = await admin
      .from("ai_insights")
      .select("content")
      .eq("scope", "product_reco")
      .eq("prompt_hash", promptHash)
      .maybeSingle();
    const hit = cached?.content as ProductRecommendation | undefined;
    if (hit?.verdict) {
      return NextResponse.json({ ok: true, recommendation: { ...hit, funnel } });
    }
  }

  let recommendation: ProductRecommendation;
  if (apiKey) {
    recommendation = (await viaClaude(m, funnel, apiKey)) ?? heuristic(m, funnel);
  } else {
    recommendation = heuristic(m, funnel);
  }

  // Кэшируем только настоящие Claude-ответы
  if (admin && recommendation.source === "claude") {
    await admin.from("ai_insights").insert({
      org_id: DEMO_ORG_ID,
      scope: "product_reco",
      scope_ref: m.nmId ? String(m.nmId) : m.productId,
      model: MODEL,
      prompt_hash: promptHash,
      content: recommendation,
    });
  }

  return NextResponse.json({ ok: true, recommendation });
}
