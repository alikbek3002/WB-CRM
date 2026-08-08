-- ─────────────────────────────────────────────────────────────────────────────
-- 0041: Остатки FBS (личные склады продавца) — вкладка на «Остатках».
--   Marketplace API отдаёт склады продавца (GET /api/v3/warehouses) и остатки
--   по chrtID размеров (POST /api/v3/stocks/{id}, ≤1000 chrtIds, ответ
--   {stocks:[{sku, chrtId, amount}]}; контракт проверен вживую 2026-08-08).
--   chrtID приходят из карточек (content-api sizes[]), до сих пор в БД
--   не сохранялись — заводим справочник product_sizes: он же задел под
--   будущие сборочные задания FBS.
--   Срезы FBS храним ОТДЕЛЬНО от stock_snapshots: FBO-агрегаты 0016 и
--   «Остаток» на Товарах не должны поменять смысл.
-- ─────────────────────────────────────────────────────────────────────────────

-- Размеры карточек: chrtID — ключ Marketplace API
create table product_sizes (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  chrt_id    bigint not null,
  tech_size  text,
  barcode    text,          -- первый sku размера: fallback-матчинг ответа stocks
  synced_at  timestamptz not null default now(),
  unique (chrt_id)          -- chrtID глобально уникален в WB; upsert по нему
);

create index idx_product_sizes_product on product_sizes (product_id);

-- Личные склады продавца (отдельно: склад с нулевым остатком тоже показываем)
create table fbs_warehouses (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  warehouse_id  bigint not null,
  name          text not null,
  office_id     bigint,
  cargo_type    integer,
  delivery_type integer,
  is_deleting   boolean not null default false,
  synced_at     timestamptz not null default now(),
  unique (store_id, warehouse_id)
);

-- Срезы остатков FBS. size '' вместо null: null в unique-ключе ломает дедуп.
create table fbs_stock_snapshots (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  warehouse_id   bigint not null,
  warehouse_name text not null,
  size           text not null default '',
  chrt_id        bigint,   -- трассировка до размера WB; в ключ не входит
  amount         integer not null default 0,
  snapshot_date  date not null,
  created_at     timestamptz not null default now(),
  unique (product_id, warehouse_id, size, snapshot_date)
);

create index idx_fbs_stock_date on fbs_stock_snapshots (snapshot_date desc);

-- Последний срез FBS-остатков (по образцу agg_stock_by_warehouse 0016):
-- глобальный max(snapshot_date) корректен — весь срез пишется одним прогоном.
create or replace function agg_fbs_stock_latest(p_store uuid)
returns table(
  product_id uuid, warehouse_id bigint, warehouse_name text,
  size text, qty bigint, snapshot_date date
)
language sql stable as $$
  with latest as (
    select max(fs.snapshot_date) as d
    from fbs_stock_snapshots fs join products p on p.id = fs.product_id
    where p.store_id = p_store
  )
  select fs.product_id, fs.warehouse_id, fs.warehouse_name, fs.size,
         sum(fs.amount), (select d from latest)
  from fbs_stock_snapshots fs
  join products p on p.id = fs.product_id
  where p.store_id = p_store and fs.snapshot_date = (select d from latest)
  group by 1, 2, 3, 4
  having sum(fs.amount) > 0;
$$;

-- sync_runs: + 'fbs' (полный список из 0031, иначе прогоны молча не логируются)
alter table sync_runs drop constraint sync_runs_source_check;
alter table sync_runs add constraint sync_runs_source_check check (
  source in (
    'orders', 'sales', 'stocks', 'cards', 'funnel', 'advert', 'finance',
    'wb-payouts', 'balance', 'aggregates',
    'incomes', 'storage', 'acceptance', 'tariffs', 'fbs'
  )
);

-- RLS: чтение — своя организация; пишет только сервисный слой (service_role
-- обходит RLS) — политик на запись не заводим, как у raw_* в 0033.
alter table product_sizes       enable row level security;
alter table fbs_warehouses      enable row level security;
alter table fbs_stock_snapshots enable row level security;

create policy "product_sizes: read own org" on product_sizes
  for select using (product_org(product_id) in (select auth_org_ids()));
create policy "fbs_warehouses: read own org" on fbs_warehouses
  for select using (store_org(store_id) in (select auth_org_ids()));
create policy "fbs_stock: read own org" on fbs_stock_snapshots
  for select using (product_org(product_id) in (select auth_org_ids()));
