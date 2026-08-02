-- 0033: новые сырые данные WB API (по образцу 0005/0026):
--   raw_incomes       — поставки FBW: что и когда приняли склады WB
--                       (statistics-api /supplier/incomes);
--   raw_storage_daily — платное хранение по товару/дню/складу
--                       (seller-analytics /paid_storage, task-based). Точнее,
--                       чем storage_fee финотчёта, где nm_id часто пустой;
--   raw_acceptance    — платная приёмка по поставке/товару
--                       (seller-analytics /acceptance_report, task-based).
-- Пишет только сервисный слой (service_role), дедупликация unique + upsert.

create table raw_incomes (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references stores(id) on delete cascade,
  income_id        bigint not null,          -- номер поставки WB
  number           text,                     -- номер УПД (если есть)
  income_date      date,                     -- дата поставки
  last_change_date timestamptz,              -- курсор инкрементального синка
  nm_id            bigint,
  barcode          text,
  tech_size        text,
  quantity         integer default 0,
  total_price      numeric(14,2) default 0,
  date_close       date,                     -- дата принятия (закрытия)
  warehouse        text,
  status           text,                     -- «Принято»
  raw              jsonb,
  synced_at        timestamptz not null default now(),
  unique (store_id, income_id, nm_id, barcode)
);

create index idx_raw_incomes_date on raw_incomes (store_id, income_date desc);
create index idx_raw_incomes_nm   on raw_incomes (store_id, nm_id);

create table raw_storage_daily (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  nm_id           bigint not null,
  stat_date       date not null,
  warehouse       text not null default '',
  warehouse_price numeric(14,2) default 0,   -- стоимость хранения за день, ₽
  barcodes_count  integer default 0,
  volume          numeric(10,3),             -- объём, л
  raw             jsonb,
  synced_at       timestamptz not null default now(),
  unique (store_id, nm_id, stat_date, warehouse)
);

create index idx_raw_storage_date on raw_storage_daily (store_id, stat_date desc);
create index idx_raw_storage_nm   on raw_storage_daily (store_id, nm_id);

create table raw_acceptance (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  income_id      bigint not null,            -- номер поставки (связь с raw_incomes)
  nm_id          bigint,
  gi_create_date date,                       -- дата создания поставки
  count          integer default 0,          -- принято, шт
  total          numeric(14,2) default 0,    -- стоимость приёмки, ₽
  subject_name   text,
  raw            jsonb,
  synced_at      timestamptz not null default now(),
  unique (store_id, income_id, nm_id, gi_create_date)
);

create index idx_raw_acceptance_date on raw_acceptance (store_id, gi_create_date desc);

-- RLS: чтение — своя org (как wb_balance в 0026), запись — service_role
alter table raw_incomes       enable row level security;
alter table raw_storage_daily enable row level security;
alter table raw_acceptance    enable row level security;

create policy "raw_incomes: read own org" on raw_incomes
  for select using (store_org(store_id) in (select auth_org_ids()));
create policy "raw_storage_daily: read own org" on raw_storage_daily
  for select using (store_org(store_id) in (select auth_org_ids()));
create policy "raw_acceptance: read own org" on raw_acceptance
  for select using (store_org(store_id) in (select auth_org_ids()));
