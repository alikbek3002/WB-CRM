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

  // Ретрай на 409 Conflict: при деплое старый контейнер ещё держит getUpdates
  // несколько секунд. Раньше сразу падали → рестарт ВСЕГО контейнера (вместе с
  // вебом — краткий даунтайм). Теперь ждём и пробуем снова.
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query"],
        onStart: (info) =>
          console.log(`✓ Бот @${info.username} запущен (long polling). Открой Telegram → /start`),
      });
      return; // штатная остановка (bot.stop)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("409") && attempt < 12) {
        console.warn(`бот: 409 Conflict (другой инстанс ещё жив), попытка ${attempt}/12 — жду 10с…`);
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      throw e;
    }
  }
}

main().catch((e) => {
  console.error("✗ Бот не запустился:", e?.message ?? e);
  process.exit(1);
});
