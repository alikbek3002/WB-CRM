// Автономный запуск Telegram-бота в режиме long polling (для локали / VPS,
// где нет публичного HTTPS-URL под вебхук).
//   npm run bot
// Грузит .env.local (node --env-file) и запускает бота из общего ядра.
// Long polling и webhook взаимоисключающи → перед стартом снимаем вебхук.

import { BOT_COMMANDS, createBot } from "../src/backend/telegram/bot";
import { schedulerTick } from "../src/backend/telegram/scheduler";

async function main(): Promise<void> {
  const bot = createBot();

  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  await bot.api.setMyCommands(BOT_COMMANDS).catch(() => {});

  // Планировщик мини-помощника: утренняя рассылка задач, напоминания за час
  // до дедлайна, вечерняя сводка руководству. Тик раз в минуту, идемпотентно.
  setInterval(() => void schedulerTick().catch(() => {}), 60_000);
  void schedulerTick().catch(() => {});

  const stop = async (sig: string): Promise<void> => {
    console.log(`\n${sig} — останавливаю бота…`);
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await bot.start({
    drop_pending_updates: false,
    allowed_updates: ["message", "callback_query"],
    onStart: (info) =>
      console.log(`✓ Бот @${info.username} запущен (long polling). Открой Telegram → /start`),
  });
}

main().catch((e) => {
  console.error("✗ Бот не запустился:", e?.message ?? e);
  process.exit(1);
});
