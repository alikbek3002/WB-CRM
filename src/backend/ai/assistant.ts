// ИИ-ассистент WB CRM на Claude. Общий для веб-чата и Telegram-бота.
// Умеет ДЕЙСТВИЯ (tool use): создать задачу, закрыть свою по регламенту,
// достать цифры конкретного товара. Права инструментов проверяются на сервере.
// Относительные импорты чистых shared — работает и в tsx-боте.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotUser } from "./snapshot";
import { executeTool, toolsForRole } from "./tools";

export const AI_MODEL = "claude-sonnet-5";

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

// Канал вывода: в Telegram сотрудник читает с телефона и понимает только
// ограниченный HTML; в вебе теги отрисовались бы как текст.
export type Channel = "telegram" | "web";

// Правила оформления — самое важное для читабельности: сплошная «простыня»
// текста в телефоне нечитаема, нужны короткие блоки, пустые строки и эмодзи.
function formatRules(channel: Channel): string[] {
  const common = [
    "",
    "КАК ОФОРМЛЯТЬ ОТВЕТ (важно — читают с телефона, между делом):",
    "- Первая строка — сразу суть/ответ. Детали ниже.",
    "- Дроби ответ на короткие блоки по 1–3 строки, между блоками — ПУСТАЯ СТРОКА. Никогда не отправляй сплошную простыню текста.",
    "- Перечисления — каждый пункт с НОВОЙ строки и с эмодзи-маркером в начале: 🗒 задача, 📦 товар, ⏰ срок, 💰 деньги, 📈 рост, 📉 падение, ⚠️ проблема, ✅ сделано, 🔴 критично, • обычный пункт.",
    "- Держись ~10 строк, если не просят подробнее. Лучше меньше, но по делу.",
    "- Не пиши «Вот список», «Как я могу помочь» и прочую воду — сразу к делу.",
    "- Большие числа разделяй пробелами: «15 938 шт», «119 042 412 ₽» — а не «15938» и «119042412». Даты пиши по-человечески: «до 27 июля», «просрочена на 3 дня», а не «2026-07-27».",
  ];
  if (channel === "telegram") {
    return [
      ...common,
      "- Выделяй ключевые числа, имена и названия жирным через <b>текст</b>. Это ЕДИНСТВЕННЫЙ разрешённый тег (можно ещё <i>текст</i>).",
      "- НИКОГДА не используй Markdown (**жирный**, ##, ```) и другие HTML-теги — они не отрисуются.",
    ];
  }
  return [
    ...common,
    "- Пиши обычным текстом: без Markdown и без HTML-тегов — они отобразятся как есть.",
  ];
}

function systemPrompt(user: SnapshotUser, snapshot: string, channel: Channel): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const weekday = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][now.getDay()];
  return [
    "Ты — ИИ-ассистент CRM-системы для селлера Wildberries. Помогаешь сотруднику прямо внутри системы.",
    "",
    `Сегодня: ${today} (${weekday}), время ${pad(now.getHours())}:${pad(now.getMinutes())}.`,
    `Сотрудник: ${user.name}, роль «${user.roleLabel}». Организация: ${user.orgName}.`,
    "",
    "АКТУАЛЬНЫЕ ДАННЫЕ МАГАЗИНА (только то, что доступно этой роли):",
    snapshot,
    "",
    "ПРАВИЛА:",
    "- Отвечай по-русски, кратко и по делу, дружелюбно. Без воды.",
    "- Опирайся ТОЛЬКО на данные выше. Если данных для ответа нет — честно скажи, что этой информации в системе пока нет (например, не подключены финотчёты WB или воронка). НЕ выдумывай цифры.",
    "- Числа бери из сводки. Если спрашивают о том, чего нет в сводке (конкретный товар не в списке, история за прошлый месяц) — скажи, где это посмотреть в системе (страница «Товары», «Остатки», «Финансы», «Регламент»).",
    "- Даёшь практичные советы селлеру WB: что делать со слабым товаром, куда отгружать, как выполнять план. Учитывай специфику Wildberries (выкуп, ДРР, ранжирование, остатки по складам).",
    "- Не раскрывай данные, которых нет в сводке — их роль не видит.",
    "- Ты не только отвечаешь, но и ДЕЙСТВУЕШЬ через инструменты: поставить задачу, закрыть задачу с отчётом, отменить задачу, показать свои задачи, отчёт по команде, закрыть задачу регламента, данные товара. Если сотрудник просит действие — выполняй его инструментом, а не пересказывай, как сделать вручную. После действия коротко подтверди результат.",
    "- ГЛАВНОЕ ПРАВИЛО ПО ЗАДАЧАМ: задачу нельзя закрыть без отчёта о том, что реально сделано. Если человек говорит «закрой задачу», «сделал», «готово», но НЕ рассказал, что именно сделано — сначала спроси: «Что именно сделали? Напишите пару предложений — это увидит руководство». И только получив ответ, вызывай complete_task с текстом отчёта. Не придумывай отчёт за сотрудника.",
    "- Сообщение могло прийти голосовым и быть распознано автоматически: возможны опечатки и ошибки в именах — понимай по смыслу, при неоднозначности переспроси.",
    ...formatRules(channel),
  ].join("\n");
}

// Вызов Claude с историей и инструментами (агент-цикл до 4 шагов).
// db нужен для исполнения инструментов; без него ассистент работает только «на чтение».
export async function askAssistant(params: {
  user: SnapshotUser;
  snapshot: string;
  history: ChatMessage[];
  db?: SupabaseClient;
  channel?: Channel; // как оформлять ответ (по умолчанию — веб)
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return "ИИ-ассистент пока не подключён. Добавьте ANTHROPIC_API_KEY в настройки.";
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  // Последние 12 сообщений истории — держим контекст, но не раздуваем
  const history = params.history.slice(-12).filter((m) => m.content.trim());
  if (!history.length || history[history.length - 1].role !== "user") {
    return "Задайте вопрос — например: «Какой товар продаётся лучше всего?» или «Выполняем ли план?»";
  }

  const tools = params.db ? toolsForRole(params.user.role) : [];
  const system = [
    {
      type: "text" as const,
      text: systemPrompt(params.user, params.snapshot, params.channel ?? "web"),
      cache_control: { type: "ephemeral" as const },
    },
  ];

  // Агент-цикл: модель может позвать инструмент → исполняем → возвращаем результат
  type AnyMessage = { role: "user" | "assistant"; content: unknown };
  const messages: AnyMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  for (let step = 0; step < 4; step++) {
    const res = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system,
      tools: tools.length ? (tools as never) : undefined,
      // История собрана из наших же структур — форма совместима с API
      messages: messages as never,
    });

    if (res.stop_reason === "tool_use" && params.db) {
      const toolResults: unknown[] = [];
      for (const block of res.content) {
        if (block.type === "tool_use") {
          const output = await executeTool(
            params.db,
            params.user,
            block.name,
            (block.input ?? {}) as Record<string, unknown>,
          );
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }
      }
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const text = res.content.find((b) => b.type === "text");
    return text && text.type === "text"
      ? text.text.trim()
      : "Не удалось сформировать ответ, попробуйте переформулировать.";
  }
  return "Действие оказалось сложнее, чем ожидалось — попробуйте разбить запрос на шаги.";
}
