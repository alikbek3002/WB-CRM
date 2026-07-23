-- WB CRM · Миграция 0005: сырые данные Wildberries API (раздел 4.4 плана)
-- Данные пишутся только сервисным слоем (service_role), дедупликация через unique + upsert.

-- Заказы (statistics-api /orders)
create table raw_orders (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  srid           text,                     -- уникальный id заказа WB (для дедупликации)
  nm_id          bigint,
  order_date     timestamptz,
  price          numeric(12,2),            -- цена со скидкой продавца
  finished_price numeric(12,2),            -- цена с учётом СПП
  spp_percent    numeric(6,2),             -- скидка постоянного покупателя
  warehouse      text,
  region         text,
  is_cancel      boolean default false,
  raw            jsonb,                    -- полный ответ на всякий случай
  synced_at      timestamptz not null default now(),
  unique (store_id, srid)
);

-- Продажи/выкупы (statistics-api /sales)
create table raw_sales (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  srid            text,
  sale_id         text,                    -- Sxxxx = продажа, Rxxxx = возврат
  nm_id           bigint,
  sale_date       timestamptz,
  price_with_disc numeric(12,2),
  for_pay         numeric(12,2),           -- к перечислению продавцу
  spp_percent     numeric(6,2),
  is_return       boolean default false,
  raw             jsonb,
  synced_at       timestamptz not null default now(),
  unique (store_id, srid, sale_id)
);

-- Воронка продаж (seller-analytics nm-report / sales-funnel) по дням
create table raw_funnel_daily (
  id                       uuid primary key default gen_random_uuid(),
  store_id                 uuid not null references stores(id) on delete cascade,
  nm_id                    bigint not null,
  stat_date                date not null,
  open_card_count          integer default 0,     -- переходы в карточку
  add_to_cart_count        integer default 0,     -- корзина
  orders_count             integer default 0,     -- заказы
  orders_sum_rub           numeric(14,2) default 0,
  buyouts_count            integer default 0,     -- выкупы
  buyouts_sum_rub          numeric(14,2) default 0,
  cancel_count             integer default 0,
  add_to_cart_conversion   numeric(6,2),          -- CR в корзину %
  cart_to_order_conversion numeric(6,2),          -- CR в заказ %
  buyout_percent           numeric(6,2),
  raw                      jsonb,
  synced_at                timestamptz not null default now(),
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
