# WB CRM — аналитика и планирование для селлеров Wildberries

Реализация по `PLAN.md` (Фаза 0 + Фаза 1: каркас, панели ролей, миграции БД).

**Стек:** Next.js 15 (App Router, TypeScript) · Tailwind 4 + shadcn/ui · Recharts ·
TanStack Query/Table · Zustand · Supabase (Postgres + Auth + Vault). Бэкенд —
Route Handlers Next.js (`src/app/api/*`, Node.js runtime).

## Запуск

```bash
npm install
npm run dev          # http://localhost:3000
```

Без ключей Supabase приложение работает в **демо-режиме** на мок-данных
(`src/backend/data/mock.ts`). В шапке — переключатель панелей:
**Директор** (owner, все разделы) ⇄ **Старший менеджер** (manager: Дашборд,
РНП с редактированием планов, Товары, Финансы, Задачи), а также Аналитик и
Наблюдатель для проверки матрицы прав (раздел 5.1 плана).

## Подключение Supabase (3 шага)

Файл `.env.local` уже создан в корне — секреты `CRON_SECRET` и
`TELEGRAM_WEBHOOK_SECRET` сгенерированы. Осталось вписать ключи Supabase.

1. **Ключи.** В `.env.local` заполните из Supabase Dashboard → Project Settings:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY` (вкладка **API**);
   - `SUPABASE_DB_URL` (вкладка **Database** → Connection string → URI).
2. **Миграции** (один раз на свежей базе, 11 файлов по порядку):
   ```bash
   npm run db:push       # применяет supabase/migrations/*.sql через psql
   ```
   Если `0001_extensions.sql` сообщил, что `pg_cron` / `pgmq` / `supabase_vault`
   недоступны — включите их в Dashboard → Database → Extensions и повторите.
3. **Демо-данные** (организация, магазин, товары, заказы/продажи за 30 дней,
   финансы, планы РНП, задачи):
   ```bash
   npm run db:seed       # идемпотентно, можно запускать повторно
   ```

После этого Дашборд, Товары, Финансы, Задачи и Тарифы читаются из **реальной БД**
(провайдер `src/backend/data/supabase.ts`); если данных нет — автоматический откат
на демо. РНП-сетка и Команда пока на мок-данных (Фаза 5 / реальная авторизация).
Проверить источник: `GET /api/health` → `{"dataSource":"supabase"|"mock"}`.

### Что в миграциях

| Файл | Содержимое |
|---|---|
| `0001_extensions.sql` | pgcrypto, pg_cron, pgmq, vault |
| `0002_orgs_roles.sql` | orgs, profiles, enum member_role, org_members, invites |
| `0003_stores_integrations.sql` | stores, integration_credentials (ключи → Vault) |
| `0004_products_stock.sql` | product_groups, products, stock_snapshots |
| `0005_raw_wb.sql` | raw_orders / raw_sales / raw_funnel_daily / raw_advert_daily / raw_finance_report |
| `0006_rnp_tasks.sql` | rnp_plans, competitor_benchmarks, tasks, task_comments |
| `0007_ai_sync.sql` | ai_insights, sync_runs, audit_log |
| `0008_tariffs.sql` | tariffs + сиды тарифов + FK orgs.plan_code |
| `0009_rls.sql` | RLS-политики и хелперы auth_org_ids/auth_role (раздел 5) |
| `0010_indexes_views.sql` | индексы + витрины mv_rnp_* + refresh_rnp_views() |
| `0011_triggers_onboarding.sql` | триггеры updated_at, автопрофиль, create_org_with_owner, accept_invite |

## Структура

Код разделён на слои: **роутинг** (`app/`, обязателен для Next.js), **фронт**
(`frontend/`), **бэк** (`backend/`), **общее** (`shared/`) и **БД** (`supabase/`).

```
src/
  app/                  РОУТИНГ (тонкий слой Next.js App Router)
    (app)/              страницы: dashboard, rnp, products, finance, tasks,
                        team, settings/integrations, tariffs
    api/                Route Handlers (Node.js): health, dashboard, rnp,
                        rnp/plans, products, tasks
    actions/            Server Actions (напр. переключение демо-роли)

  frontend/             ФРОНТ (клиент + презентация)
    components/         ui (shadcn) · layout · dashboard (KPI+графики) · rnp · charts
    supabase/client.ts  браузерный клиент Supabase

  backend/              БЭК (server-only логика)
    data/               index (диспетчер mock↔supabase) · supabase · mock
    supabase/           server (SSR, RLS) · admin (service_role)
    auth/session.ts     сессия (демо-роль из cookie; далее — Supabase Auth)

  shared/               ОБЩЕЕ (фронт + бэк)
    rbac.ts             роли и матрица прав (раздел 5.1)
    types.ts            контракты данных панелей
    format.ts · utils.ts · constants.ts

supabase/migrations/    БД: SQL-миграции 0001–0011
scripts/                db-push.sh (миграции) · seed.mjs (демо-данные)
```

Границы: клиентские компоненты тянут из `backend/` только типы (`import type`),
серверный код в браузер не попадает. Псевдоним `@/*` → `src/*` (все слои).

## Дальше по плану (PLAN.md, раздел 15)

- Фаза 2: страница «Интеграции» с реальным сохранением WB-токена в Vault + `WildberriesClient.validateToken`
- Фаза 3: синхронизация raw-слоя (pgmq + pg_cron + Edge Function)
- Фаза 4: дашборд на реальных витринах
- Фаза 5: полный РНП (TanStack Table + виртуализация, Excel-экспорт)
