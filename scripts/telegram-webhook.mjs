// Управление вебхуком Telegram-бота (для продакшена).
// Запуск (грузит .env.local через node --env-file):
//   npm run bot:webhook set     — поставить вебхук на $NEXT_PUBLIC_APP_URL/api/telegram
//   npm run bot:webhook set https://my-domain.com   — явный базовый URL
//   npm run bot:webhook info    — показать текущий вебхук
//   npm run bot:webhook delete  — снять вебхук (нужно перед long-polling `npm run bot`)
//
// Секрет вебхука (TELEGRAM_WEBHOOK_SECRET) передаётся Telegram и проверяется
// в src/app/api/telegram/route.ts (заголовок X-Telegram-Bot-Api-Secret-Token).

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

if (!TOKEN) {
  console.error("✗ Нет TELEGRAM_BOT_TOKEN в .env.local");
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const cmd = process.argv[2] ?? "info";

async function main() {
  if (cmd === "set") {
    if (!SECRET) {
      console.error(
        "✗ Нет TELEGRAM_WEBHOOK_SECRET в .env.local — вебхук без секрета принимал бы поддельные запросы.\n" +
          "  Заполни TELEGRAM_WEBHOOK_SECRET и повтори.",
      );
      process.exit(1);
    }
    const base = (process.argv[3] ?? APP_URL ?? "").replace(/\/+$/, "");
    if (!base || !base.startsWith("https://")) {
      console.error(
        "✗ Нужен публичный HTTPS-URL. Укажи явно:  npm run bot:webhook set https://твой-домен\n" +
          "  Локально (http://localhost) вебхук не поставить — используй `npm run bot` (long polling).",
      );
      process.exit(1);
    }
    const url = `${base}/api/telegram`;
    const res = await api("setWebhook", {
      url,
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    console.log(res.ok ? `✓ Вебхук установлен: ${url}` : `✗ ${JSON.stringify(res)}`);
  } else if (cmd === "delete") {
    const res = await api("deleteWebhook", { drop_pending_updates: false });
    console.log(res.ok ? "✓ Вебхук снят" : `✗ ${JSON.stringify(res)}`);
  } else {
    const res = await api("getWebhookInfo");
    console.log(JSON.stringify(res.result ?? res, null, 2));
  }
}

main().catch((e) => {
  console.error("✗", e?.message ?? e);
  process.exit(1);
});
