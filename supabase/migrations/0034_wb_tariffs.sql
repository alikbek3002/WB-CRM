-- 0034: справочники тарифов WB (common-api /tariffs/*) — для ПРОГНОЗНОЙ
-- юнит-экономики (факт удержаний живёт в raw_finance_report/raw_storage_daily).
-- Имена с префиксом wb_: таблица tariffs из 0008 — это тарифы нашего SaaS.

-- Комиссия WB по предметам (категориям), %
create table wb_commission_tariffs (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references stores(id) on delete cascade,
  subject_id             integer not null,
  parent_name            text,
  subject_name           text,
  kgvp_marketplace       numeric(6,2) default 0,  -- FBW (склад WB)
  kgvp_supplier          numeric(6,2) default 0,  -- FBS (склад продавца)
  kgvp_supplier_express  numeric(6,2) default 0,  -- экспресс
  paid_storage_kgvp      numeric(6,2) default 0,
  updated_at             timestamptz not null default now(),
  unique (store_id, subject_id)
);

-- Тарифы складов WB: логистика и хранение коробов
create table wb_box_tariffs (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  warehouse_name text not null,
  delivery_base  numeric(10,2) default 0,   -- логистика: первый литр, ₽
  delivery_liter numeric(10,2) default 0,   -- логистика: доп. литр, ₽
  storage_base   numeric(10,4) default 0,   -- хранение: первый литр, ₽/день
  storage_liter  numeric(10,4) default 0,   -- хранение: доп. литр, ₽/день
  expr_pct       numeric(6,2)  default 0,   -- коэффициент склада, %
  dt_from        date,
  dt_till        date,
  updated_at     timestamptz not null default now(),
  unique (store_id, warehouse_name)
);

alter table wb_commission_tariffs enable row level security;
alter table wb_box_tariffs        enable row level security;

create policy "wb_commission_tariffs: read own org" on wb_commission_tariffs
  for select using (store_org(store_id) in (select auth_org_ids()));
create policy "wb_box_tariffs: read own org" on wb_box_tariffs
  for select using (store_org(store_id) in (select auth_org_ids()));
