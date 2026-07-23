# WB CRM — Платформа аналитики и планирования для селлеров Wildberries

> Полный технический план разработки. Документ рассчитан на то, чтобы вы могли реализовать платформу с помощью Claude Fable 5 (`claude-fable-5`), передавая ему этот файл целиком и отдельные разделы как ТЗ по фазам.

**Дата составления:** 2026-07-05
**Стек:** Next.js 15 + Supabase (Postgres/Auth/Storage/Realtime/Edge Functions) + Claude API + Telegram Bot
**Вертикаль:** SaaS-аналитика для продавцов маркетплейсов (в первую очередь Wildberries)

---

## 0. Как пользоваться этим документом с Fable 5

1. Реализуйте по фазам (раздел 15). Не пытайтесь сгенерировать всё сразу — это приведёт к некачественному коду.
2. Для каждой фазы копируйте её «Промпт для Fable 5» + соответствующие разделы (схема БД, метрики, API).
3. Модель по умолчанию для написания кода — `claude-fable-5` (самая мощная). Для аналитики внутри приложения (раздел 9) — `claude-sonnet-5` (баланс цена/качество), для тяжёлого разбора — `claude-opus-4-8`.
4. Все секреты (WB-ключ, Claude-ключ, Telegram-токен) храните только на сервере, зашифрованными (раздел 13). Никогда не отдавайте их в браузер.

---

## 1. Что это за продукт (анализ КП / скриншотов)

На скриншотах — рабочая аналитическая платформа для селлера Wildberries. Мы воспроизводим и расширяем следующие модули:

### 1.1. Дашборд (скрин 1)
Сводная витрина по магазину с фильтрами: `Маркетплейсы · Магазины · Бренды · Категории · Группы · Артикулы` и выбором периода.

KPI-карточки:
- **Чистая прибыль** (₽ + % рентабельности)
- **Продажи / Выкупы** (₽ + шт)
- **Заказы** (₽ + шт)
- **Остатки на складе** (шт, склады WB)

Графики:
- **Динамика заказов** — столбчатый график по дням (сумма выкупов ₽ + количество).
- **Остатки по складам** — donut-диаграмма (топ складов WB).
- **Заказы за период** — линейный тренд (сумма + количество).

### 1.2. Модуль РНП (скрин 2) — ядро платформы
РНП = **Рабочий Недельный План** (план/факт по каждому SKU с юнит-экономикой и воронкой). Это самая сложная и ценная часть.

Структура:
- Фильтры: `Все секции · План → неделя · Текущий (месяц/год) · [Excel-экспорт]`.
- Вкладки по товарам/секциям: `Общий · Сводная · Кимоно · Рубашка · костюм_гипюр_айвори …` (у каждого SKU свой ярлык + счётчик).
- **Карточка товара**: фото, название, себестоимость, Рентабельность %, Маржа %, Прибыль, ДРР %, CTR %, Показов, Выкуп %, CRO %, логистика, «В деньгах» и «В долларах».
- **Матрица размеров**: `XXS XS S M L XL XXL 2XL 3XL 4XL 5XL Σ` × строки `На складе / В пути / Общий / В пошиве`.
- **Временная сетка**: недели `Нед 1…5 · ИТОГ` + дневные колонки (`01.07 ср`, `02.07 чт`, …).
- Строки таблицы (план vs факт):
  - Ответственный / Статус (напр. «Локомотив»)
  - **ЗАКАЗЫ** (шт) · План заказ
  - **СПП %** (скидка постоянного покупателя)
  - **Продажи** (шт) · План продаж
  - **СР. Чек**
  - **Раздачи** (самовыкупы для буста)
  - Процент выполнения плана · Выпол. плана ЗАКАЗ · Выпол. плана ПРОДАЖ
  - Блок **СУММА ПРОДАЖ ₽**: Сумма Заказов, Сумма Продаж
  - Блок **ПОКАЗАТЕЛИ ВОРОНКИ**: Показы, % органики показов, План Показов, Клики, CTR %, Корзина %, % Корзина конкурентов, Корзина (шт), Заказы %, % Заказов конкурентов, CRO %, % CRO конкурентов

### 1.3. Другие разделы (из левого меню на скринах)
`Дашборд · РНП · Товары · Финансы · Ещё · Тарифы · Настройки`. Плюс наши дополнения: **Задачи** (для Telegram-бота), **Команда/Роли**, **Интеграции (API-ключи)**.

### 1.4. Что добавляем сверх скриншотов (по вашему ТЗ)
- Подключение **API-ключа Wildberries** (селлер сам вводит свой JWT-токен).
- Подключение **API-ключа Claude** (для AI-аналитики: разбор воронки, генерация рекомендаций, авто-выводы по РНП).
- **Telegram-бот** для задач и уведомлений.
- **Роли** и права доступа (RBAC).
- **Supabase** как БД + auth + хранилище + фоновые задачи.

---

## 2. Целевая архитектура

```
┌────────────────────────────────────────────────────────────────────┐
│                        Пользователь (браузер)                        │
│   Next.js App Router (RSC + Client) · shadcn/ui · TanStack Query/Table│
└───────────────┬───────────────────────────────────┬────────────────┘
                │ HTTPS                              │ Realtime (WS)
                ▼                                    ▼
┌────────────────────────────────┐        ┌──────────────────────────┐
│  Next.js API / Server Actions  │        │   Supabase Realtime       │
│  (Route Handlers на Vercel)    │        │   (обновление дашбордов)  │
│  · auth-guard + RLS-контекст   │        └──────────────────────────┘
│  · оркестрация синхронизации   │
│  · вызовы Claude API           │
└──────┬─────────────┬───────────┘
       │             │
       ▼             ▼
┌─────────────┐  ┌──────────────────────────────────────────────┐
│ Claude API  │  │            Supabase (Postgres)                │
│ (аналитика) │  │  · таблицы (raw + витрины)                     │
└─────────────┘  │  · RLS по org_id                              │
                 │  · pg_cron (расписание) + Queues              │
                 │  · Edge Functions (воркеры синка/бота)        │
                 │  · Vault (шифрование секретов)                │
                 └───────┬──────────────────────┬────────────────┘
                         │                       │
                         ▼                       ▼
              ┌────────────────────┐   ┌─────────────────────┐
              │  Wildberries API   │   │   Telegram Bot API  │
              │  (стата/контент/   │   │   (webhook)         │
              │   реклама/финансы) │   └─────────────────────┘
              └────────────────────┘
```

**Ключевые принципы:**
- **Multi-tenant SaaS**: организация (workspace) → магазины → пользователи с ролями. Изоляция данных через Postgres RLS по `org_id`.
- **Разделение сырых данных и витрин**: сырые выгрузки WB складываем в `raw_*` таблицы, метрики считаем в материализованных витринах/представлениях. Это даёт скорость дашбордов и повторную пересчётку без повторных запросов к WB.
- **Инкрементальная синхронизация** с учётом жёстких лимитов WB API.
- **AI как отдельный слой**: Claude вызывается из серверных функций, результат кэшируется в БД.

---

## 3. Технологический стек (обоснование)

| Слой | Технология | Почему |
|---|---|---|
| Frontend | **Next.js 15 (App Router) + React + TypeScript** | SSR/RSC, легко деплоится на Vercel, отлично генерируется Fable 5 |
| UI-kit | **Tailwind CSS + shadcn/ui** | тёмная тема как на скринах, быстрый набор компонентов |
| Графики | **Recharts** (или Tremor) | донат/бары/линии из дашборда |
| Таблицы | **TanStack Table + TanStack Virtual** | сложная сетка РНП с виртуализацией (много колонок/строк) |
| Server-state | **TanStack Query** | кэш, инвалидация, оптимистик-апдейты |
| Client-state | **Zustand** | локальные фильтры/выбор периода |
| Формы | **React Hook Form + Zod** | валидация ввода API-ключей, планов |
| БД / Auth / Storage | **Supabase (Postgres 15+)** | по ТЗ; даёт RLS, Realtime, Edge Functions, Vault |
| Фон/расписание | **Supabase Edge Functions + pg_cron + pgmq (Queues)** | синхронизация WB по расписанию, обработка очередей |
| ORM/доступ к БД | **Drizzle ORM** (или supabase-js) | типобезопасные запросы, миграции |
| AI | **Anthropic SDK (`@anthropic-ai/sdk`)** | аналитика на Claude; модели `claude-sonnet-5` / `claude-opus-4-8` |
| Telegram | **grammY** | современный TS-фреймворк для ботов, webhook на Edge Function |
| Деплой | **Vercel** (front+API) + **Supabase Cloud** | минимум DevOps |
| Аналитика ошибок | **Sentry** | опционально |

> Альтернатива для тяжёлой синхронизации при росте: вынести воркеры в отдельный Node-сервис (Railway/Fly.io) с очередью BullMQ. Но для MVP хватает Edge Functions + pgmq.

---

## 4. Модель данных (Supabase / Postgres)

Ниже — базовая схема. Все пользовательские таблицы содержат `org_id` для RLS. Даю ключевые таблицы; в фазе 2 расширяем витринами.

### 4.1. Организации, пользователи, роли

```sql
-- Организация (рабочее пространство / тенант)
create table orgs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  plan_code    text not null default 'trial',   -- см. tariffs
  created_at   timestamptz not null default now()
);

-- Профиль пользователя (связан с auth.users Supabase)
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text,
  telegram_id  bigint unique,           -- для привязки Telegram
  telegram_username text,
  created_at   timestamptz not null default now()
);

-- Роли пользователя в организации (многие-ко-многим)
create type member_role as enum ('owner','admin','manager','analyst','viewer');

create table org_members (
  org_id       uuid not null references orgs(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  role         member_role not null default 'viewer',
  created_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Приглашения в команду
create table invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  email        text not null,
  role         member_role not null default 'viewer',
  token        text not null unique,
  accepted_at  timestamptz,
  expires_at   timestamptz not null default now() + interval '7 days'
);
```

### 4.2. Магазины и API-ключи (интеграции)

```sql
-- Подключённый магазин WB (у одной org может быть несколько)
create table stores (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  marketplace  text not null default 'wildberries',  -- задел на Ozon и др.
  name         text not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Зашифрованные API-ключи. Сам токен НИКОГДА не хранится открытым текстом.
-- Используем Supabase Vault (см. раздел 13) — здесь ссылка на секрет.
create table integration_credentials (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  provider     text not null,            -- 'wb' | 'claude' | 'telegram'
  vault_secret_id uuid not null,         -- id секрета в vault.secrets
  scopes       text[],                   -- какие категории WB-токена (content, statistics, ...)
  status       text not null default 'pending', -- pending|valid|invalid|revoked
  last_checked_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (store_id, provider)
);
```

### 4.3. Товары, размеры, склады

```sql
-- Карточка товара (nmID = артикул WB)
create table products (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  nm_id        bigint not null,          -- артикул Wildberries
  vendor_code  text,                     -- артикул продавца
  title        text,
  brand        text,
  category     text,                     -- предмет/subject
  photo_url    text,
  status       text,                     -- 'Локомотив' и др. пользовательские статусы
  group_id     uuid references product_groups(id),
  cost_price   numeric(12,2),            -- себестоимость (вводит пользователь)
  logistics_cost numeric(12,2),
  responsible_user_id uuid references profiles(id),
  created_at   timestamptz not null default now(),
  unique (store_id, nm_id)
);

-- Пользовательские группы товаров (для фильтров дашборда)
create table product_groups (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  name         text not null
);

-- Остатки по размерам и складам (снимок на дату)
create table stock_snapshots (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  warehouse    text not null,            -- название склада WB
  size         text,                     -- XXS..5XL
  on_stock     integer not null default 0,   -- На складе
  in_transit   integer not null default 0,   -- В пути
  in_production integer not null default 0,  -- В пошиве (вводит пользователь)
  snapshot_date date not null,
  created_at   timestamptz not null default now()
);
```

### 4.4. Сырые данные WB (raw-слой)

```sql
-- Заказы (statistics-api /orders)
create table raw_orders (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  srid         text,                     -- уникальный id заказа WB (для дедупликации)
  nm_id        bigint,
  order_date   timestamptz,
  price        numeric(12,2),            -- цена со скидкой продавца
  finished_price numeric(12,2),          -- цена с учётом СПП
  spp_percent  numeric(6,2),             -- скидка постоянного покупателя
  warehouse    text,
  region       text,
  is_cancel    boolean default false,
  raw          jsonb,                    -- полный ответ на всякий случай
  synced_at    timestamptz not null default now(),
  unique (store_id, srid)
);

-- Продажи/выкупы (statistics-api /sales)
create table raw_sales (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  srid         text,
  sale_id      text,                     -- Sxxxx = продажа, Rxxxx = возврат
  nm_id        bigint,
  sale_date    timestamptz,
  price_with_disc numeric(12,2),
  for_pay      numeric(12,2),            -- к перечислению продавцу
  spp_percent  numeric(6,2),
  is_return    boolean default false,
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  unique (store_id, srid, sale_id)
);

-- Воронка продаж (seller-analytics nm-report / sales-funnel) по дням
create table raw_funnel_daily (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  nm_id        bigint not null,
  stat_date    date not null,
  open_card_count integer default 0,     -- переходы в карточку
  add_to_cart_count integer default 0,   -- корзина
  orders_count integer default 0,        -- заказы
  orders_sum_rub numeric(14,2) default 0,
  buyouts_count integer default 0,       -- выкупы
  buyouts_sum_rub numeric(14,2) default 0,
  cancel_count integer default 0,
  add_to_cart_conversion numeric(6,2),   -- CR в корзину %
  cart_to_order_conversion numeric(6,2), -- CR в заказ %
  buyout_percent numeric(6,2),
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  unique (store_id, nm_id, stat_date)
);

-- Рекламная статистика (advert-api fullstats) по дням/кампаниям
create table raw_advert_daily (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  advert_id    bigint,
  nm_id        bigint,
  stat_date    date not null,
  views        integer default 0,        -- Показы
  clicks       integer default 0,        -- Клики
  ctr          numeric(6,3),
  cpc          numeric(12,4),
  sum          numeric(14,2),            -- расход на рекламу
  atbs         integer default 0,        -- add to basket (реклама)
  orders_count integer default 0,
  cr           numeric(6,3),
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  unique (store_id, advert_id, nm_id, stat_date)
);

-- Финансовый детализированный отчёт (statistics reportDetailByPeriod)
create table raw_finance_report (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  rrd_id       bigint,                   -- строка отчёта (для дедупликации)
  nm_id        bigint,
  doc_type     text,                     -- Продажа/Возврат/Логистика/Штраф/Хранение...
  amount       numeric(14,2),
  commission   numeric(14,2),
  logistics    numeric(14,2),
  storage_fee  numeric(14,2),
  penalty      numeric(14,2),
  period_start date,
  period_end   date,
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  unique (store_id, rrd_id)
);
```

### 4.5. Планирование (РНП) и задачи

```sql
-- План по SKU на неделю (то, что вводит пользователь в модуле РНП)
create table rnp_plans (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  iso_year     smallint not null,
  iso_week     smallint not null,        -- ISO-неделя
  plan_orders  integer,                  -- План заказ (шт)
  plan_sales   integer,                  -- План продаж (шт)
  plan_views   integer,                  -- План показов
  plan_spp     numeric(6,2),             -- плановый СПП %
  giveaways    integer default 0,        -- Раздачи (самовыкупы)
  responsible_user_id uuid references profiles(id),
  note         text,
  updated_at   timestamptz not null default now(),
  unique (product_id, iso_year, iso_week)
);

-- Витрина факта по SKU за неделю/день (агрегируется из raw_*)
-- (реализуется как materialized view или таблица-агрегат, см. раздел 6)

-- Задачи (для Telegram-бота и модуля Задачи)
create type task_status as enum ('open','in_progress','done','cancelled');
create type task_priority as enum ('low','normal','high','urgent');

create table tasks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  title        text not null,
  description  text,
  status       task_status not null default 'open',
  priority     task_priority not null default 'normal',
  product_id   uuid references products(id),  -- задача может быть привязана к SKU
  assignee_id  uuid references profiles(id),
  created_by   uuid references profiles(id),
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Комментарии к задачам
create table task_comments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  author_id    uuid references profiles(id),
  body         text not null,
  created_at   timestamptz not null default now()
);
```

### 4.6. AI-инсайты и синхронизация

```sql
-- Результаты AI-аналитики (кэш ответов Claude)
create table ai_insights (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  scope        text not null,            -- 'dashboard' | 'rnp_sku' | 'funnel' ...
  scope_ref    text,                     -- напр. nm_id или период
  model        text not null,            -- claude-sonnet-5 / claude-opus-4-8
  prompt_hash  text,                     -- для дедупликации/кэша
  content      jsonb not null,           -- структурированный вывод
  tokens_in    integer,
  tokens_out   integer,
  created_at   timestamptz not null default now()
);

-- Журнал синхронизаций (что, когда, статус)
create table sync_runs (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  source       text not null,            -- 'orders'|'sales'|'funnel'|'advert'|'finance'
  status       text not null default 'running', -- running|success|error
  from_date    date,
  to_date      date,
  rows_upserted integer default 0,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
```

> **Индексы (обязательно):** по `(store_id, order_date)`, `(store_id, nm_id, stat_date)`, `(product_id, iso_year, iso_week)`, а также по `org_id` во всех таблицах для RLS-производительности.

---

## 5. Роли и права доступа (RBAC + RLS)

### 5.1. Матрица ролей

| Роль | Дашборд | РНП (просмотр) | РНП (редакт. планов) | Товары/себестоимость | Финансы | Задачи | Команда/Роли | API-ключи | Тарифы/оплата |
|---|---|---|---|---|---|---|---|---|---|
| **owner** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **manager** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **analyst** | ✅ | ✅ | ❌ | ✅ (просмотр) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **viewer** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ (свои) | ❌ | ❌ | ❌ |

### 5.2. Реализация в Postgres (RLS)

Каждый запрос выполняется от лица пользователя Supabase. RLS фильтрует по членству в организации.

```sql
-- Хелпер: список org_id, к которым принадлежит текущий пользователь
create or replace function auth_org_ids()
returns setof uuid language sql stable security definer as $$
  select org_id from org_members where user_id = auth.uid();
$$;

-- Хелпер: роль пользователя в конкретной org
create or replace function auth_role(p_org uuid)
returns member_role language sql stable security definer as $$
  select role from org_members where user_id = auth.uid() and org_id = p_org;
$$;

alter table orgs enable row level security;
alter table stores enable row level security;
alter table products enable row level security;
alter table rnp_plans enable row level security;
-- ... включить RLS на всех пользовательских таблицах

-- Пример политики чтения (данные своей организации)
create policy "read own org stores" on stores
  for select using (org_id in (select auth_org_ids()));

-- Пример политики записи планов (только manager+ )
create policy "write plans" on rnp_plans
  for all using (
    exists (
      select 1 from products p
      join stores s on s.id = p.store_id
      where p.id = rnp_plans.product_id
        and auth_role(s.org_id) in ('owner','admin','manager')
    )
  );
```

> **Важно:** проверку ролей дублируем и в серверном слое Next.js (guard перед мутациями), т.к. часть операций идёт через сервисные функции с повышенными правами (синхронизация, AI, бот).

---

## 6. Расчёт метрик (формулы)

Все метрики считаем в SQL-витринах или в серверном слое из `raw_*`. Определения (важно совпасть с логикой WB):

| Метрика | Формула | Источник |
|---|---|---|
| **Заказы (шт)** | count(raw_orders where not is_cancel) | raw_orders |
| **Сумма заказов ₽** | Σ price (или finished_price) | raw_orders |
| **Выкупы/Продажи (шт)** | count(raw_sales where not is_return) | raw_sales |
| **Сумма продаж ₽** | Σ for_pay (или price_with_disc) | raw_sales |
| **Средний чек** | Сумма продаж / Кол-во продаж | raw_sales |
| **СПП %** | avg(spp_percent) | raw_orders/sales |
| **Выкуп %** | Выкупы / Заказы × 100 | raw_* |
| **Показы** | Σ views | raw_advert_daily (реклама) |
| **Клики** | Σ clicks | raw_advert_daily |
| **CTR %** | Клики / Показы × 100 | raw_advert_daily |
| **Корзина (шт)** | Σ add_to_cart_count | raw_funnel_daily |
| **Корзина % (CR в корзину)** | Корзина / Переходы × 100 | raw_funnel_daily |
| **Заказы %** | Заказы / Корзина × 100 | raw_funnel_daily |
| **CRO % / CR0** | Заказы / Переходы × 100 (общая конверсия) | raw_funnel_daily |
| **% органики показов** | (Показы − реклам. показы) / Показы × 100 | funnel − advert |
| **ДРР %** (доля рекламных расходов) | Расход на рекламу / Сумма заказов × 100 | raw_advert + orders |
| **Себестоимость** | вводится пользователем | products.cost_price |
| **Маржа %** | (Цена продажи − себест − комиссия − логистика) / Цена × 100 | products + finance |
| **Прибыль ₽** | Сумма продаж − себест×кол-во − комиссия − логистика − реклама − хранение − штрафы | raw_finance + products |
| **Рентабельность %** | Прибыль / Выручка × 100 | вычисляемая |
| **% выполнения плана ЗАКАЗ** | Факт заказы / plan_orders × 100 | rnp_plans + факт |
| **% выполнения плана ПРОДАЖ** | Факт продажи / plan_sales × 100 | rnp_plans + факт |
| **Раздачи** | plan/учёт самовыкупов | rnp_plans.giveaways |

> **Сравнение с конкурентами** (`% Корзина конкурентов`, `% Заказов конкурентов`, `% CRO конкурентов`) — данных по конкурентам в базовом WB API нет. Варианты: (а) оставить ручной ввод бенчмарка на уровне категории; (б) интеграция со сторонним сервисом (MPStats и т.п.) в отдельной фазе. В MVP — ручной ввод/заглушка.

Витрину факта по SKU/неделе делаем как материализованное представление и обновляем после каждой синхронизации:

```sql
create materialized view mv_rnp_fact as
select
  p.id as product_id,
  p.store_id,
  extract(isoyear from o.order_date)::smallint as iso_year,
  extract(week    from o.order_date)::smallint as iso_week,
  count(*) filter (where not o.is_cancel)          as fact_orders,
  sum(o.price) filter (where not o.is_cancel)      as fact_orders_sum,
  avg(o.spp_percent)                               as avg_spp
from products p
join raw_orders o on o.store_id = p.store_id and o.nm_id = p.nm_id
group by 1,2,3,4;
-- + аналогичные агрегаты по продажам/воронке; refresh после sync
```

---

## 7. Интеграция с Wildberries API

### 7.1. Аутентификация
WB использует единый **JWT-токен**, который селлер генерирует в личном кабинете (Настройки → Доступ к API). Токен выпускается с выбором **категорий доступа** (scopes): Контент, Аналитика, Статистика, Цены и скидки, Продвижение (реклама), Маркетплейс, Финансы, Отзывы/Вопросы, Чат.

- Заголовок запроса: `Authorization: <JWT>`.
- Токен вводит пользователь на странице «Интеграции». Мы проверяем его тестовым запросом и определяем доступные категории.
- Храним **зашифрованным** (Supabase Vault), см. раздел 13.

### 7.2. Базовые хосты и эндпоинты (по категориям)

> ⚠️ WB периодически меняет хосты/пути и лимиты. Перед реализацией сверьтесь с актуальной докой `dev.wildberries.ru`. Ниже — ориентир на 2025–2026.

| Категория | Базовый хост (ориентир) | Что берём |
|---|---|---|
| Статистика | `statistics-api.wildberries.ru` | `/api/v1/supplier/orders`, `/sales`, `/stocks`, `/reportDetailByPeriod` |
| Аналитика (воронка) | `seller-analytics-api.wildberries.ru` | `nm-report/detail`, `nm-report/grouped`, sales-funnel |
| Контент | `content-api.wildberries.ru` | список карточек (`/content/v2/get/cards/list`) — фото, бренд, предмет, размеры |
| Цены и скидки | `discounts-prices-api.wildberries.ru` | текущие цены, СПП |
| Продвижение (реклама) | `advert-api.wildberries.ru` | список кампаний, `/adv/v2/fullstats` (показы, клики, CTR, расход) |
| Маркетплейс | `marketplace-api.wildberries.ru` | заказы FBS, остатки |
| Финансы | `finance-api.wildberries.ru` / statistics | детализация к перечислению |

**Разбиение метрик РНП по источникам:**
- **Показы / Клики / CTR / Расход / ДРР** → рекламный API (`fullstats`).
- **Переходы в карточку / Корзина / Заказы / Выкупы / CRO** → аналитический API воронки (`nm-report`).
- **СПП / Средний чек / Суммы** → статистика (orders/sales).
- **Себестоимость / В пошиве / Раздачи / Планы** → ручной ввод (наши таблицы).

### 7.3. Лимиты и стратегия синхронизации

WB жёстко лимитирует API (у многих отчётов — порядка **1 запрос/минуту**, у рекламы — секундные лимиты с burst). Поэтому:

1. **Инкрементальность.** Для orders/sales используем параметр `dateFrom` и флаг `flag`; храним «последнюю синхронизированную дату» в `sync_runs`. Дозагружаем только новое.
2. **Дедупликация.** Уникальные ключи: `srid` (orders), `srid+sale_id` (sales), `rrd_id` (finance), `(nm_id, stat_date)` (воронка). Всё через `upsert (on conflict do update)`.
3. **Rate-limiting.** Очередь `pgmq` + воркер, который уважает лимиты (задержки между вызовами, экспоненциальный backoff при 429). Не запускаем параллельные тяжёлые отчёты по одному магазину.
4. **Расписание** через `pg_cron`:
   - orders/sales/stocks — каждые 30–60 мин;
   - воронка (nm-report) — 1–2 раза в день (данные за 7 дней);
   - реклама fullstats — 2–4 раза в день;
   - финансовый отчёт — раз в день/неделю (по готовности отчёта WB).
5. **Идемпотентность.** Каждый `sync_run` можно перезапустить без дублей.

### 7.4. Абстракция клиента

Сделать типизированный клиент `WildberriesClient` с методами `getOrders`, `getSales`, `getStocks`, `getNmReport`, `getAdvertFullstats`, `getFinanceReport`, `getCards`, `validateToken`. Внутри — единый rate-limiter, ретраи, логирование в `sync_runs`. Клиент получает расшифрованный токен только на время запроса (из Vault), в память приложения надолго не кладём.

---

## 8. Слой синхронизации (воркеры)

```
pg_cron ──► ставит задачи в очередь pgmq (sync:orders, sync:funnel, …)
                     │
                     ▼
        Edge Function "sync-worker" (по таймеру/по сообщению)
          1. читает задачу из очереди
          2. берёт store + расшифровывает WB-токен из Vault
          3. вызывает WildberriesClient (с rate-limit)
          4. upsert в raw_* (дедуп)
          5. пишет sync_runs (success/error)
          6. триггерит refresh материализованных витрин
```

- Одна Edge Function на источник (или одна универсальная с параметром `source`).
- Ретраи: при 429 — повторная постановка задачи с задержкой; при 5xx — backoff.
- Уведомление в Telegram при падении синка (для admin/owner).

---

## 9. AI-аналитика на Claude API

### 9.1. Что делает AI

1. **Разбор воронки SKU**: почему проседает CTR/корзина/CRO, что улучшить (фото, цена, СПП, реклама).
2. **Авто-выводы по РНП**: план vs факт — где отставание, прогноз выполнения недельного плана.
3. **Дашборд-саммари**: краткий текст «что произошло за период» + аномалии.
4. **Рекомендации по рекламе**: перераспределить бюджет на SKU с лучшим CRO.
5. **Ответы на вопросы** (чат-аналитик): «Какие товары убыточны на этой неделе?» — с доступом к агрегатам через structured output / tool use.

### 9.2. Технические правила (важно для Fable 5)

- SDK: `@anthropic-ai/sdk`. Вызовы только на сервере (Server Action / Route Handler / Edge Function).
- Модели: по умолчанию `claude-sonnet-5` для регулярной аналитики; `claude-opus-4-8` для глубоких разборов; `claude-haiku-4-5` для дешёвых массовых классификаций.
- **Не передавать сырые токены/секреты в промпт.** В контекст даём только агрегированные метрики (числа), без ключей.
- **Structured output**: используем `output_config.format` с JSON-схемой, чтобы получать машиночитаемые выводы (список проблем + рекомендации + приоритет). Пример структуры:

```jsonc
{
  "summary": "строка",
  "problems": [{ "metric": "CTR", "severity": "high", "reason": "…" }],
  "recommendations": [{ "action": "…", "impact": "…", "priority": 1 }]
}
```

- **Кэш**: сохраняем ответ в `ai_insights` c `prompt_hash`; если данные не менялись — не дёргаем API повторно.
- **Prompt caching**: стабильную часть промпта (инструкция аналитика) кэшируем через `cache_control`, переменную часть (метрики периода) — в конце.
- **Ключ Claude**: у платформы может быть свой ключ (тариф включает лимит токенов) ИЛИ пользователь подключает свой ключ на странице «Интеграции» (провайдер `claude`, хранится в Vault так же, как WB). По ТЗ — поддержать оба режима; какой использовать, определяем по настройке магазина/тарифа.
- **Учёт расхода токенов**: пишем `tokens_in/tokens_out` в `ai_insights`, ограничиваем по тарифу.

### 9.3. Пример вызова (ориентир)

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: decryptedClaudeKey });

const res = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 4000,
  system: [{ type: "text", text: ANALYST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  output_config: { format: { type: "json_schema", schema: INSIGHT_SCHEMA } },
  messages: [{ role: "user", content: JSON.stringify(metricsForPeriod) }],
});
```

> Для «чата-аналитика» с доступом к БД — использовать tool use: определить инструмент `query_metrics(period, nm_id, metric)`, который безопасно ходит в наши агрегаты (не в raw SQL от модели), а Claude оркестрирует вызовы.

---

## 10. Telegram-бот (задачи + уведомления)

### 10.1. Функции
- **Привязка аккаунта**: пользователь жмёт «Подключить Telegram» в вебе → получает код/ссылку → бот сохраняет `telegram_id` в `profiles`.
- **Задачи**: создать (`/task`), посмотреть свои (`/mytasks`), сменить статус, получить напоминание о дедлайне. Назначение исполнителя.
- **Уведомления**: новая задача назначена мне; изменился статус; упал синк WB; критическая аномалия по метрике (проседание выкупа/CTR); напоминание заполнить недельный план РНП.
- **Быстрые сводки**: `/summary` — короткий дайджест по магазину (использует тот же AI-слой).

### 10.2. Реализация
- Библиотека **grammY**, webhook принимаем в Supabase Edge Function `telegram-webhook` (или Next.js route `/api/telegram`).
- Токен бота храним в Vault (провайдер `telegram`), задаётся на уровне платформы (один бот) — пользователи привязывают свои чаты.
- Проверка `secret_token` вебхука (защита от подделки).
- Rate-limit исходящих сообщений (Telegram лимиты).
- Кнопки (inline keyboard) для смены статуса задач.

### 10.3. Привязка (flow)
```
Веб: кнопка "Подключить Telegram" → генерим одноразовый deep-link t.me/bot?start=<token>
Бот: /start <token> → находим invite по token → сохраняем telegram_id в profiles → «Аккаунт привязан»
```

---

## 11. Модули приложения (детально)

### 11.1. Дашборд (`/dashboard`)
- Панель фильтров (Маркетплейсы/Магазины/Бренды/Категории/Группы/Артикулы) + date-range picker. Состояние фильтров в URL (`searchParams`) и Zustand.
- 4 KPI-карточки (см. 1.1) — данные из витрин, лоадеры-скелетоны.
- Графики: Recharts (BarChart «Динамика заказов», Pie/Donut «Остатки по складам», LineChart «Заказы за период»).
- Блок AI-саммари (кнопка «Собрать выводы» → `ai_insights`).
- Realtime-обновление после синка (Supabase channel).

### 11.2. Модуль РНП (`/rnp`) — самый сложный
- Табы по SKU/секциям (Общий, Сводная, + по товарам). Счётчики на табах.
- Карточка товара сверху: фото, экономика (себест, маржа, прибыль, ДРР, CTR, показы, выкуп, CRO), «В деньгах/В долларах».
- Матрица размеров (На складе/В пути/Общий/В пошиве) — редактируемая для «В пошиве».
- Основная сетка (TanStack Table + виртуализация): недели `Нед 1..5 · ИТОГ` + дневные колонки. Строки: Заказы/План, СПП, Продажи/План, Ср.чек, Раздачи, % выполнения, Суммы, Воронка.
- **Инлайн-редактирование планов** (`plan_orders`, `plan_sales`, `plan_views`, `giveaways`) с оптимистик-апдейтом и записью в `rnp_plans` (проверка роли manager+).
- Переключатель «План → неделя/месяц».
- Экспорт в **Excel** (кнопка на скрине): генерация xlsx (`exceljs`) на сервере.
- Цветовая индикация выполнения плана (зелёный/красный, как на скрине).
- AI-разбор по SKU (кнопка → рекомендации из `ai_insights`).

### 11.3. Товары (`/products`)
- Список карточек (nm_id, vendor_code, бренд, категория, статус, себестоимость, ответственный).
- Ввод себестоимости/логистики (влияет на маржу/прибыль).
- Группы товаров, статусы («Локомотив» и др.), назначение ответственного.

### 11.4. Финансы (`/finance`)
- Отчёт из `raw_finance_report`: продажи, комиссии, логистика, хранение, штрафы, к перечислению.
- Прибыль/убыток по SKU и по магазину, помесячно.

### 11.5. Задачи (`/tasks`)
- Канбан/список (open/in_progress/done). Приоритеты, дедлайны, исполнители, привязка к SKU.
- Комментарии. Синхронизация с Telegram-ботом.

### 11.6. Команда и роли (`/team`)
- Список участников, смена ролей (owner/admin), приглашения по email (`invites`).

### 11.7. Интеграции (`/settings/integrations`)
- Ввод и проверка **WB-токена** (показываем доступные категории после валидации).
- Ввод **Claude-ключа** (опционально; иначе используется ключ платформы по тарифу).
- Подключение **Telegram**.
- Статусы подключений, дата последней синхронизации, кнопка «Синхронизировать сейчас».

### 11.8. Тарифы (`/tariffs`)
- Планы подписки (см. раздел 12), текущий план, лимиты (кол-во магазинов, токены AI, частота синка).

---

## 12. Тарифы (SaaS-биллинг)

```sql
create table tariffs (
  code         text primary key,        -- 'trial'|'start'|'pro'|'business'
  name         text not null,
  price_month  numeric(10,2) not null,
  max_stores   integer not null,
  max_products integer,
  ai_tokens_month integer,              -- лимит токенов Claude
  sync_interval_min integer,            -- минимальная частота синка
  features     jsonb                     -- флаги фич
);
```
- Ограничения тарифа проверяются перед действиями (добавить магазин, вызвать AI сверх лимита).
- Оплата: задел под ЮKassa/CloudPayments (РФ) или Stripe. В MVP — ручное выставление плана владельцем.

---

## 13. Безопасность

- **Шифрование секретов**: WB/Claude/Telegram токены — только в **Supabase Vault** (`vault.create_secret`), в таблицах храним лишь `vault_secret_id`. Расшифровка — на сервере, короткоживущая, никогда не в браузер.
- **RLS везде**: ни один клиентский запрос не может выйти за пределы своей `org_id`.
- **Разделение ключей Supabase**: `anon` key — фронт (под RLS); `service_role` key — только в серверных функциях/воркерах (обходит RLS, использовать осторожно).
- **Проверка ролей на сервере** перед мутациями (не полагаться только на UI).
- **Валидация webhook Telegram** через `secret_token`.
- **Аудит**: логировать доступ к секретам и изменения ролей.
- **Rate-limit** на публичные эндпоинты (защита от абьюза AI/синка).
- **Не логировать** значения токенов и persональные данные покупателей.

---

## 14. Переменные окружения

```dotenv
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=            # только сервер!
SUPABASE_DB_URL=                      # для миграций (Drizzle)

# Claude (ключ платформы; пользовательские ключи — в Vault)
ANTHROPIC_API_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=

# Прочее
NEXT_PUBLIC_APP_URL=
VAULT_ENCRYPTION_KEY=                 # если своё шифрование поверх Vault
CRON_SECRET=                          # защита cron-эндпоинтов
```

---

## 15. Дорожная карта (фазы) + промпты для Fable 5

Реализуйте строго по порядку. Каждая фаза — рабочий инкремент.

### Фаза 0 — Каркас проекта
Next.js 15 + TS + Tailwind + shadcn/ui, подключение Supabase (auth), базовый лейаут с тёмной темой и боковым меню как на скринах.
> **Промпт:** «Создай Next.js 15 (App Router, TypeScript) проект с Tailwind и shadcn/ui, тёмной темой. Настрой Supabase Auth (email + magic link). Сделай защищённый layout с сайдбаром: Дашборд, РНП, Товары, Финансы, Задачи, Команда, Интеграции, Тарифы. Пока страницы — заглушки.»

### Фаза 1 — БД, RLS, роли, организации
Миграции всех таблиц раздела 4, RLS раздела 5, онбординг: создание org, роль owner.
> **Промпт:** «Реализуй схему БД из раздела 4 плана как SQL-миграции (Drizzle). Включи RLS по разделу 5. Сделай онбординг: при первом входе создаётся orgs + org_members(owner). Экран Команда с приглашениями по email и сменой ролей.»

### Фаза 2 — Интеграции: подключение WB-ключа
Страница «Интеграции», ввод/валидация WB-токена, хранение в Vault, определение категорий, `WildberriesClient.validateToken`.
> **Промпт:** «Сделай страницу Интеграции: форма ввода WB API-токена, сохранение в Supabase Vault (в таблице только vault_secret_id), серверная валидация тестовым запросом, отображение доступных категорий и статуса. Реализуй класс WildberriesClient с rate-limiter и методом validateToken.»

### Фаза 3 — Синхронизация WB (raw-слой)
`WildberriesClient` (orders/sales/stocks/cards), Edge Function `sync-worker`, pgmq + pg_cron, запись в `raw_*` с дедупликацией, журнал `sync_runs`.
> **Промпт:** «Реализуй инкрементальную синхронизацию заказов, продаж, остатков и карточек WB в raw_-таблицы с upsert-дедупликацией. Используй pgmq + pg_cron для расписания и Edge Function-воркер, уважающий лимиты WB (backoff при 429). Логируй в sync_runs. Кнопка "Синхронизировать сейчас".»

### Фаза 4 — Дашборд
Витрины/агрегаты, KPI-карточки, 3 графика (Recharts), фильтры, Realtime.
> **Промпт:** «Построй дашборд из раздела 11.1: 4 KPI-карточки (чистая прибыль, продажи, заказы, остатки), графики Динамика заказов (бар), Остатки по складам (донат), Заказы за период (линия), панель фильтров с date-range. Данные из SQL-витрин. Метрики считай по формулам раздела 6.»

### Фаза 5 — Модуль РНП
Синхронизация воронки (`nm-report`) и рекламы (`fullstats`), таблицы `rnp_plans`, витрина факта, сложная сетка (TanStack Table + virtual), инлайн-редакт планов, матрица размеров, экспорт Excel.
> **Промпт:** «Реализуй модуль РНП из раздела 11.2 и 6: синхронизация воронки и рекламной статистики WB, недельная сетка план/факт по SKU (Заказы, СПП, Продажи, Ср.чек, Раздачи, % выполнения, Суммы, Воронка), карточка экономики товара, матрица размеров, инлайн-редактирование планов (роль manager+), экспорт в Excel. Используй TanStack Table с виртуализацией.»

### Фаза 6 — AI-аналитика (Claude)
Слой `ai_insights`, structured output, кэш, AI-саммари на дашборде и разбор SKU в РНП, опциональный пользовательский Claude-ключ.
> **Промпт:** «Добавь AI-аналитику на Claude (модель claude-sonnet-5) по разделу 9: разбор воронки SKU и саммари дашборда со structured output (JSON-схема problems/recommendations), кэш в ai_insights по prompt_hash, prompt caching. Ключ берётся из Vault (пользовательский) или из ANTHROPIC_API_KEY (платформенный). Учитывай лимит токенов тарифа.»

### Фаза 7 — Задачи + Telegram-бот
Модуль Задачи (канбан), grammY-бот на webhook, привязка аккаунта, уведомления и напоминания.
> **Промпт:** «Реализуй модуль Задачи (раздел 11.5) и Telegram-бота на grammY (webhook в Edge Function, раздел 10): привязка аккаунта через deep-link, создание/назначение/смена статуса задач из бота, уведомления (новая задача, дедлайн, падение синка, аномалии метрик). Токен бота — в Vault, проверка secret_token.»

### Фаза 8 — Финансы, Тарифы, полировка
Финансовый отчёт, тарифы и лимиты, аудит, оптимизация запросов, мобильная адаптивность.
> **Промпт:** «Добавь модуль Финансы из raw_finance_report (прибыль/убыток по SKU и магазину), систему тарифов с проверкой лимитов (магазины, токены AI, частота синка), аудит доступа к секретам и смены ролей. Оптимизируй индексы и запросы.»

---

## 16. Чек-лист готовности MVP

- [ ] Регистрация/вход, организация, роли, приглашения работают под RLS.
- [ ] WB-токен вводится, валидируется, хранится зашифрованным; категории определяются.
- [ ] Инкрементальная синхронизация orders/sales/stocks/funnel/advert без дублей.
- [ ] Дашборд с KPI и 3 графиками, фильтрами, реальными данными.
- [ ] Модуль РНП: план/факт, воронка, экономика SKU, редактирование планов, Excel-экспорт.
- [ ] AI-разбор воронки и саммери дашборда (Claude), кэш, лимиты токенов.
- [ ] Telegram-бот: привязка, задачи, уведомления.
- [ ] Тарифы с лимитами; секреты в Vault; аудит.

---

## 17. Риски и заметки

- **WB API нестабилен**: хосты/пути/лимиты меняются — держите клиент абстрактным, сверяйтесь с `dev.wildberries.ru`, закладывайте graceful-degradation при недоступных категориях токена.
- **Лимиты запросов**: не гонитесь за реалтаймом по всем отчётам — часть данных обновляется раз в день, это нормально; показывайте «данные на HH:MM».
- **Данные конкурентов** (в РНП) в базовом WB API отсутствуют — MVP: ручной бенчмарк; позже — сторонний сервис.
- **Стоимость AI**: контролируйте токены (кэш, дешёвые модели для массовых задач, лимиты тарифа).
- **Персональные данные покупателей** (регионы/адреса из статистики): минимизируйте хранение, не логируйте.
- **Себестоимость и «В пошиве»** — ручной ввод; сделайте импорт из Excel для массовой загрузки.

---

*Документ готов к передаче в Fable 5 по фазам. Начинайте с Фазы 0.*
