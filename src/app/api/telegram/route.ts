// Приём вебхука Telegram (продакшн). Обновления валидируются секретом
// (заголовок X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET) —
// защита от подделки (раздел 10.2 плана).
//
// Поставить/снять вебхук:  npm run bot:webhook set https://твой-домен | delete | info
// Локально без публичного URL используйте long polling: `npm run bot`.

import { webhookCallback } from "grammy";
import { createBot } from "@/backend/telegram/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function createHandler() {
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    // Fail-closed: без секрета grammY принимал бы ЛЮБОЙ POST (поддельные апдейты).
    throw new Error("TELEGRAM_WEBHOOK_SECRET не задан — вебхук отключён (fail-closed)");
  }
  const bot = createBot();
  return webhookCallback(bot, "std/http", { secretToken });
}

let cached: ReturnType<typeof createHandler> | undefined;

export async function POST(req: Request): Promise<Response> {
  try {
    cached ??= createHandler();
    return await cached(req);
  } catch (e) {
    console.error("[telegram] ошибка вебхука:", e);
    return new Response("error", { status: 500 });
  }
}

export function GET(): Response {
  return new Response("WB CRM Telegram webhook is alive", { status: 200 });
}
