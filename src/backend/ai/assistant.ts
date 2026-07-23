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

function systemPrompt(user: SnapshotUser, snapshot: string): string {
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
    "- У тебя могут быть инструменты (создать задачу, закрыть свою задачу регламента, данные конкретного товара). Используй их, когда пользователь просит ДЕЙСТВИЕ или данные о товаре не из сводки. Перед созданием задачи убедись, что понятны исполнитель и формулировка; после действия — коротко подтверди результат.",
    "- Форматируй ответ простым текстом (можно списками через «-»). Без Markdown-заголовков.",
  ].join("\n");
}

// Вызов Claude с историей и инструментами (агент-цикл до 4 шагов).
// db нужен для исполнения инструментов; без него ассистент работает только «на чтение».
export async function askAssistant(params: {
  user: SnapshotUser;
  snapshot: string;
  history: ChatMessage[];
  db?: SupabaseClient;
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
      text: systemPrompt(params.user, params.snapshot),
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
