-- WB CRM · Миграция 0013: цепочка поставок (КП: Фабрика → Поставка → Оплата → Приёмка → Склады WB)
-- Фабрика (Китай/Узбекистан) отшивает товар (2 стоимости: отшивка + карго, мультивалюта ¥/сум/₽),
-- карточка поставки едет в Москву («В пути» → авто «Приехал» через 15 дней → приёмка «Товар прибыл»
-- с фиксацией недостач → распределение по складам WB). Мультивалютные оплаты привязаны к поставке.
-- store_id/org_id-скоуп, unique-ключи под upsert, RLS зеркалит 0009, индексы в стиле 0010.

------------------------------------------------------------------------------
-- factories — фабрика-производитель (страна: china | uzbekistan)
------------------------------------------------------------------------------

create table factories (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  country     text not null check (country in ('china','uzbekistan')),
  note        text,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

------------------------------------------------------------------------------
-- supplies — карточка отгрузки (одна карточка = один товар, как в КП)
-- Единый жизненный статус: in_transit → arrived (авто 15 дн) → received (приёмка) →
--   sorting (в разборе) → in_stock (лежит) → distributed (распределён по WB); cancelled.
------------------------------------------------------------------------------

create table supplies (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  factory_id    uuid not null references factories(id) on delete restrict,
  product_id    uuid references products(id) on delete set null,  -- опц. связь с карточкой WB
  title         text not null,                                    -- наименование, как ввели
  quantity      integer not null default 0,                       -- отгружено, шт
  ship_date     date not null,
  -- две стоимости (мультивалюта): отшивка (долг фабрике) + карго (перевозка)
  sewing_cost     numeric(14,2) not null default 0,
  sewing_currency text not null default 'cny' check (sewing_currency in ('cny','uzs','rub')),
  cargo_cost      numeric(14,2) not null default 0,
  cargo_currency  text not null default 'cny' check (cargo_currency in ('cny','uzs','rub')),
  status        text not null default 'in_transit'
                  check (status in ('in_transit','arrived','received','sorting','in_stock','distributed','cancelled')),
  -- приёмка в Москве
  received_at     timestamptz,
  received_qty    integer,                    -- фактически принято
  receipt_comment text,                       -- «пришёл весь» / описание недостачи
  transit_days    integer,                    -- авто: received_at::date − ship_date
  responsible_user_id uuid references profiles(id) on delete set null,
  created_by      uuid references profiles(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

------------------------------------------------------------------------------
-- supply_payments — оплаты по поставке (товар/карго), мультивалюта ¥/сум/₽
------------------------------------------------------------------------------

create table supply_payments (
  id          uuid primary key default gen_random_uuid(),
  supply_id   uuid not null references supplies(id) on delete cascade,
  kind        text not null check (kind in ('goods','cargo')),   -- за товар / за карго
  amount      numeric(14,2) not null default 0,
  currency    text not null default 'cny' check (currency in ('cny','uzs','rub')),
  paid_at     date not null,
  note        text,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

------------------------------------------------------------------------------
-- wb_distributions — распределение поставки по складам Wildberries
------------------------------------------------------------------------------

create table wb_distributions (
  id          uuid primary key default gen_random_uuid(),
  supply_id   uuid not null references supplies(id) on delete cascade,
  warehouse   text not null,
  quantity    integer not null default 0,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Триггер updated_at на supplies (функция set_updated_at из 0011)
------------------------------------------------------------------------------

create trigger trg_supplies_updated_at
  before update on supplies
  for each row execute function set_updated_at();

------------------------------------------------------------------------------
-- Индексы (стиль 0010)
------------------------------------------------------------------------------

create index idx_factories_org        on factories (org_id);
create index idx_supplies_org_status  on supplies (org_id, status);
create index idx_supplies_factory     on supplies (factory_id);
create index idx_supplies_product     on supplies (product_id);
create index idx_supplies_ship_date   on supplies (ship_date);
create index idx_supply_payments_supply on supply_payments (supply_id);
create index idx_wb_distributions_supply on wb_distributions (supply_id);

------------------------------------------------------------------------------
-- RLS (зеркалит 0009: чтение — члены org; запись — manager+; service_role обходит)
------------------------------------------------------------------------------

-- org_id поставки по её id (для payments/distributions, привязанных через supply_id)
create or replace function supply_org(p_supply uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from supplies where id = p_supply;
$$;

alter table factories        enable row level security;
alter table supplies         enable row level security;
alter table supply_payments  enable row level security;
alter table wb_distributions enable row level security;

-- factories
create policy "factories: read own org" on factories
  for select using (org_id in (select auth_org_ids()));
create policy "factories: managers write" on factories
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

-- supplies
create policy "supplies: read own org" on supplies
  for select using (org_id in (select auth_org_ids()));
create policy "supplies: managers write" on supplies
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

-- supply_payments
create policy "supply_payments: read own org" on supply_payments
  for select using (supply_org(supply_id) in (select auth_org_ids()));
create policy "supply_payments: managers write" on supply_payments
  for all using (auth_role(supply_org(supply_id)) in ('owner','admin','manager'))
  with check (auth_role(supply_org(supply_id)) in ('owner','admin','manager'));

-- wb_distributions
create policy "wb_distributions: read own org" on wb_distributions
  for select using (supply_org(supply_id) in (select auth_org_ids()));
create policy "wb_distributions: managers write" on wb_distributions
  for all using (auth_role(supply_org(supply_id)) in ('owner','admin','manager'))
  with check (auth_role(supply_org(supply_id)) in ('owner','admin','manager'));
