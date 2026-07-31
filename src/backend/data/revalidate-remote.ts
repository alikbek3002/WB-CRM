// Сброс кэша чтения ИЗ ПРОЦЕССА, который не является Next.
//
// Контракт кэша (см. cachedRead в ./index): после любой записи в БД надо сбросить
// тег WB_DATA_TAG, иначе веб до 30 минут показывает старые данные. Внутри Next это
// делает ./revalidate → revalidateTag(). Но Telegram-бот на Railway — ОТДЕЛЬНЫЙ
// процесс (scripts/run-bot.ts, tsx): revalidateTag() там недоступен физически,
// он живёт в памяти веб-сервера. Поэтому бот дёргает веб по HTTP.
//
// Чистый модуль (только fetch) — резолвится и в Turbopack, и в tsx.
// Best effort: без APP_URL/CRON_SECRET (локальная разработка) — тихий no-op,
// ошибка сети не роняет мутацию, которая уже успешно записалась в БД.

let lastPing = 0;
const MIN_INTERVAL_MS = 1000; // защита от шквала пингов при пакете мутаций

export async function invalidateRemote(): Promise<void> {
  const appUrl = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!appUrl || !secret) return;

  const now = Date.now();
  if (now - lastPing < MIN_INTERVAL_MS) return;
  lastPing = now;

  try {
    await fetch(`${appUrl.replace(/\/$/, "")}/api/cron/revalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[revalidate-remote] пинг не прошёл:", e);
  }
}
