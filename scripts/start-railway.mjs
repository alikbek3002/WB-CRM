// Запуск на Railway: веб (next start) + Telegram-бот с планировщиком —
// в одном сервисе. Если любой из процессов умирает, контейнер завершается
// с ошибкой → Railway перезапускает оба (restartPolicy ON_FAILURE).

import { spawn } from "node:child_process";

function run(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    console.error(`[start-railway] ${name} завершился (code=${code}, signal=${signal}) — рестарт контейнера`);
    process.exit(code === 0 ? 1 : (code ?? 1));
  });
  return child;
}

console.log("[start-railway] запускаю web (next start) + telegram-бот…");
const web = run("web", "npx", ["next", "start", "-p", process.env.PORT ?? "3000"]);
const bot = run("bot", "node", ["--import", "tsx", "scripts/run-bot.ts"]);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    web.kill(sig);
    bot.kill(sig);
    setTimeout(() => process.exit(0), 5000);
  });
}
