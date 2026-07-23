# Telegram-бот WB CRM

Бот **@wb_crmnur_bot** — вход для сотрудников по логину/паролю и меню по роли.

## Как это работает

1. Сотрудник открывает Telegram → `@wb_crmnur_bot` → `/start`.
2. Вводит **логин** (короткий: `director`, `marat`, … — или свой email) и **пароль**.
3. Пароль проверяется через **Supabase Auth** (`signInWithPassword`).
4. При совпадении бот **привязывает** Telegram-аккаунт к профилю (`profiles.telegram_id`) и показывает **меню по роли** (RBAC).
5. При следующем `/start` вход не нужен — бот сразу открывает меню. Выйти: `/logout`.

Разделы меню зависят от роли (права из `src/shared/rbac.ts`) и показывают **реальные данные из Supabase**:

| Раздел | Право | owner (Директор) | manager (Ст. менеджер) | analyst | viewer |
|---|---|:--:|:--:|:--:|:--:|
| 🗒 Мои задачи (+ смена статуса) | `tasks:view` | ✅ | ✅ | ✅ | ✅ |
| 📊 Сводка магазина (7/30 дней) | `dashboard:view` | ✅ | ✅ | ✅ | ✅ |
| 🚚 Поставки | `supply:view` | ✅ | ✅ | ✅ | ✅ |
| 📦 Товары | `products:view` | ✅ | ✅ | ✅ | ❌ |
| 💰 Финансы | `finance:view` | ✅ | ✅ | ✅ | ❌ |
| 👥 Команда | `team:manage` | ✅ | ❌ | ❌ | ❌ |

## Доступы (команда)

Вход в бота есть всегда, независимо от того, как настроена БД — те же логины/пароли
провижнят **оба** скрипта:

- `npm run db:bootstrap` — чистый каркас (org + магазин + команда, БЕЗ демо-чисел);
- `npm run db:seed` — то же + демо-датасет (заказы/поставки/задачи для показа интерфейса).

> Если разделы меню (Сводка/Задачи/Финансы) пустые или по нулям — это ожидаемо для
> чистого каркаса: бизнес-данные заводятся в приложении или приходят из синхронизации WB.
> Нужны числа для демо — прогони `npm run db:seed`.

Логины и пароли (печатаются в консоль после `npm run db:seed`):

| Логин | Пароль | Роль | Сотрудник |
|---|---|---|---|
| `director` | `Director-2026` | Директор (owner) | Айгерим Директорова |
| `marat` | `Marat-2026` | Старший менеджер | Марат Менеджеров |
| `aliya` | `Aliya-2026` | Старший менеджер | Алия Сатпаева |
| `daniyar` | `Daniyar-2026` | Аналитик | Данияр Аналитиков |
| `guest` | `Guest-2026` | Наблюдатель | Гость Инвесторов |

Вход возможен и по email (`director@demo.wbcrm` и т.д.). Сменить пароли — отредактировать `USERS` в `scripts/seed.mjs` и снова `npm run db:seed` (пароли обновляются идемпотентно).

## Запуск

### Локально / VPS (long polling) — работает сразу, без публичного URL

```bash
npm run bot
```

Бот подключается к Telegram и слушает обновления. Пока команда работает — бот онлайн. Остановить — `Ctrl+C`.

### Продакшн (webhook на Vercel/сервере с HTTPS)

Обновления принимает роут `POST /api/telegram` (проверяет секрет `TELEGRAM_WEBHOOK_SECRET`).

```bash
# поставить вебхук на $NEXT_PUBLIC_APP_URL/api/telegram
npm run bot:webhook set https://ваш-домен.com
npm run bot:webhook info      # проверить
npm run bot:webhook delete    # снять (нужно перед возвратом к `npm run bot`)
```

> Long polling (`npm run bot`) и webhook взаимоисключающи. `npm run bot` сам снимает вебхук на старте.

## Переменные окружения (`.env.local`)

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | секрет для валидации вебхука (уже сгенерирован) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon-ключ — проверка пароля (`signInWithPassword`) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role — чтение/запись данных бота (обходит RLS) |
| `NEXT_PUBLIC_APP_URL` | база для установки вебхука |

## Архитектура

```
Telegram ──▶ long polling (scripts/run-bot.ts)  ─┐
         └─▶ webhook POST /api/telegram          ─┴─▶ createBot()  (src/backend/telegram/bot.ts)
                                                          │
                        ┌─────────────────────────────────┼─────────────────────────────┐
                        ▼                                  ▼                             ▼
              Supabase Auth (anon)              profiles.telegram_id            рабочие таблицы
              signInWithPassword               (привязка аккаунта)         (service_role, tasks/…)
```

- **`src/backend/telegram/bot.ts`** — единое ядро (grammY): вход, привязка, ролевые меню, разделы. Импортирует только npm-пакеты и чистые общие модули → работает и в Turbopack (webhook), и в tsx (раннер).
- **`src/app/api/telegram/route.ts`** — webhook (`runtime = "nodejs"`, проверка secret).
- **`scripts/run-bot.ts`** — long-polling запуск (`npm run bot`).
- **`scripts/telegram-webhook.mjs`** — управление вебхуком.
- **`supabase/migrations/0014_telegram_bot.sql`** — `profiles.login` (unique, регистронезависимо) + `telegram_sessions` (состояние пошагового входа).

## БД

| Объект | Роль |
|---|---|
| `profiles.login` | короткий логин (уникальный, регистронезависимый) |
| `profiles.telegram_id` / `telegram_username` | привязка Telegram-аккаунта (уже в схеме с 0002) |
| `telegram_sessions` | шаг диалога входа (`idle` / `await_login` / `await_password`) по `chat_id` |

## Заметки безопасности

- Пароль проверяется через Supabase Auth; в БД в открытом виде не хранится и не логируется.
- Бот пытается удалить сообщение с паролем; в личных чатах Telegram это запрещает — сообщение остаётся в истории (ограничение Telegram).
- Вебхук защищён секретным токеном (заголовок `X-Telegram-Bot-Api-Secret-Token`).
- `telegram_id` уникален: при входе он снимается с других профилей и ставится текущему.
