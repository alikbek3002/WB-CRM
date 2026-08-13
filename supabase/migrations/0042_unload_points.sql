-- ─────────────────────────────────────────────────────────────────────────────
-- 0042: Куда разгружаем — города фул-фирм и справочники складов WB.
--
--   До этой миграции город разгрузки нигде не хранился: страница «Фул-фирма»
--   просто утверждала «склад приёмки в Москве», а склад WB в распределении
--   вбивался руками строкой. Между тем у кабинета УЖЕ 10 личных складов
--   (fbs_warehouses, 0041) в разных городах, и WB отдаёт по ним всё нужное:
--
--   • marketplace-api GET /api/v3/offices — 77 офисов, поле city (проверено
--     вживую 2026-08-13). fbs_warehouses.office_id ссылается ровно на этот id,
--     поэтому город каждой точки разгрузки берётся джойном: «Фбс каз» → офис
--     3019093 → Ульяновск, «фбс санк» → 10999 → Санкт-Петербург.
--   • supplies-api GET /api/v1/warehouses — 18 складов WB (ID, адрес, режим,
--     активность). Это «куда» после разбора: раньше wb_distributions.warehouse
--     заполняли свободным текстом, теперь выбирают из списка.
--
--   Итого две разные точки маршрута, которые раньше путались в одном слове
--   «склад»: (1) КУДА приезжает карго с фабрики — город фул-фирмы; (2) КУДА
--   уезжает разобранный товар — склад WB.
-- ─────────────────────────────────────────────────────────────────────────────

-- Офисы (пункты приёмки) WB — единственный источник городов по API
create table wb_offices (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references stores(id) on delete cascade,
  office_id        bigint not null,
  name             text not null,
  city             text,
  address          text,
  federal_district text,
  cargo_type       integer,
  delivery_type    integer,
  synced_at        timestamptz not null default now(),
  unique (store_id, office_id)
);

create index idx_wb_offices_city on wb_offices (store_id, city);

-- Склады WB для отгрузки FBW — «куда» после разбора у фул-фирмы
create table wb_warehouses (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  wb_id             bigint not null,
  name              text not null,
  address           text,
  work_time         text,
  is_active         boolean not null default true,
  is_transit_active boolean not null default false,
  synced_at         timestamptz not null default now(),
  unique (store_id, wb_id)
);

-- Город личного склада: денормализуем из офиса при синке, чтобы список точек
-- разгрузки не зависел от того, дожил ли офис до следующей выгрузки WB.
alter table fbs_warehouses add column city text;

-- Фул-фирма: город разгрузки и связь со своим складом в кабинете WB
alter table fulfillment_partners
  add column city             text,
  add column fbs_warehouse_id bigint;   -- = fbs_warehouses.warehouse_id (не FK: справочник per-store)

-- Поставка: куда разгружаем. Город фиксируем на карточке, а не выводим из
-- фул-фирмы: подрядчика могут сменить или не привлекать вовсе («разбираем
-- сами»), а факт «карго приехало в Казань» остаётся частью истории партии.
alter table supplies add column unload_city text;

create index idx_supplies_unload_city on supplies (org_id, unload_city);

-- RLS: чтение — своя организация; справочники пишет только сервисный слой
-- (service_role обходит RLS) — как у raw_* в 0033 и складов FBS в 0041.
alter table wb_offices    enable row level security;
alter table wb_warehouses enable row level security;

create policy "wb_offices: read own org" on wb_offices
  for select using (store_org(store_id) in (select auth_org_ids()));
create policy "wb_warehouses: read own org" on wb_warehouses
  for select using (store_org(store_id) in (select auth_org_ids()));
