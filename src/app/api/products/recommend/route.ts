import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import type { ProductRecommendation } from "@/shared/types";

export const runtime = "nodejs";

// Рекомендации ИИ по «слабому» товару. Реально через Claude при наличии
// ANTHROPIC_API_KEY (structured output, кэш в ai_insights); иначе — детерминированная
// эвристика. UI не различает источник. Модель — claude-sonnet-5 (раздел 9 PLAN.md).
const MODEL = "claude-sonnet-5";

const metricsSchema = z.object({
  productId: z.string(),
  nmId: z.number().optional(),
  title: z.string(),
  status: z.string().optional(),
  salesRank30d: z.number(),
  avgDailySales: z.number(),
  daysOfCover: z.number().nullable(),
  stockQty: z.number(),
  inTransitToMoscow: z.number(),
});
type Metrics = z.infer<typeof metricsSchema>;

// ─── Детерминированная эвристика (fallback без ключа) ─────────────────────────

function heuristic(m: Metrics): ProductRecommendation {
  const problems: ProductRecommendation["problems"] = [];
  const recommendations: ProductRecommendation["recommendations"] = [];

  const cover = m.daysOfCover;
  if (cover !== null && cover < 14 && m.inTransitToMoscow === 0) {
    problems.push({
      metric: "Остаток",
      severity: "high",
      reason: `Запаса ~${cover} дн, в пути ничего нет — риск out-of-stock.`,
    });
    recommendations.push({
      action: "Срочно оформить поставку на фабрике (отшивка + карго)",
      impact: "Избежать потери позиций и продаж из-за нуля остатков",
      priority: 1,
    });
  } else if (cover !== null && cover < 30) {
    recommendations.push({
      action: "Запланировать дозаказ — запас заканчивается в этом месяце",
      impact: "Поддержать бесперебойные продажи",
      priority: 2,
    });
  }

  if (m.salesRank30d < 120) {
    problems.push({
      metric: "Продажи",
      severity: m.salesRank30d < 60 ? "high" : "medium",
      reason: `Всего ${m.salesRank30d} продаж за 30 дней (~${m.avgDailySales}/день) — товар продаётся слабо.`,
    });
    recommendations.push({
      action: "Обновить фото/заголовок и проверить цену + рекламные ставки",
      impact: "Поднять CTR и конверсию карточки",
      priority: recommendations.length ? 3 : 1,
    });
  }

  // Затоваривание: cover > 120 дн — проблема независимо от объёма продаж
  // (тот же порог, что и isWeak, — иначе «слабый» товар получит «всё в норме»)
  if (cover !== null && cover > 120) {
    problems.push({
      metric: "Оборачиваемость",
      severity: "medium",
      reason:
        m.salesRank30d < 120
          ? `Запаса на ~${cover} дн при слабых продажах — затоваривание и расходы на хранение.`
          : `Запаса на ~${cover} дн — избыточный сток, замороженные деньги и хранение.`,
    });
    recommendations.push({
      action:
        m.salesRank30d < 120
          ? "Снизить цену / раздачи для буста, приостановить закупки"
          : "Приостановить закупки до нормализации запаса",
      impact: "Ускорить оборачиваемость, снизить хранение",
      priority: 3,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      action: "Показатели в норме — держать текущую стратегию",
      impact: "Стабильные продажи",
      priority: 3,
    });
  }

  const summary =
    problems.length === 0
      ? `«${m.title}»: критичных проблем нет.`
      : `«${m.title}»: ${problems.map((p) => p.metric.toLowerCase()).join(", ")} требуют внимания.`;

  return {
    productId: m.productId,
    source: "heuristic",
    summary,
    problems,
    recommendations: recommendations.sort((a, b) => a.priority - b.priority),
  };
}

// ─── Claude (при наличии ключа) ───────────────────────────────────────────────

const ANALYST_SYSTEM = `Ты — аналитик маркетплейса Wildberries. По метрикам одного товара
дай краткий разбор: что не так и что конкретно сделать селлеру. Пиши по-русски, по делу,
без воды. Учитывай: запас на сколько дней хватает (daysOfCover), сколько в пути в Москву,
скорость продаж. Верни строго JSON по схеме.`;

async function viaClaude(m: Metrics, apiKey: string): Promise<ProductRecommendation | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
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
              action: { type: "string" },
              impact: { type: "string" },
              priority: { type: "integer" },
            },
            required: ["action", "impact", "priority"],
          },
        },
      },
      required: ["summary", "problems", "recommendations"],
    };

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: "text", text: ANALYST_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: JSON.stringify(m) }],
    });

    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    const parsed = JSON.parse(text.text) as Omit<ProductRecommendation, "productId" | "source">;
    return { productId: m.productId, source: "claude", ...parsed };
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

  const promptHash = createHash("sha256")
    .update(`${MODEL}:${JSON.stringify(m)}`)
    .digest("hex")
    .slice(0, 32);
  const admin = getSupabaseAdmin();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Кэш ai_insights (если есть БД и ключ — считаем настоящим Claude-ответом)
  if (admin && apiKey) {
    const { data: cached } = await admin
      .from("ai_insights")
      .select("content")
      .eq("scope", "product_reco")
      .eq("prompt_hash", promptHash)
      .maybeSingle();
    if (cached?.content) {
      return NextResponse.json({ ok: true, recommendation: cached.content });
    }
  }

  let recommendation: ProductRecommendation;
  if (apiKey) {
    recommendation = (await viaClaude(m, apiKey)) ?? heuristic(m);
  } else {
    recommendation = heuristic(m);
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
