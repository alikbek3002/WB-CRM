-- WB CRM · Миграция 0004: товары, группы, остатки (раздел 4.3 плана)

-- Пользовательские группы товаров (для фильтров дашборда)
create table product_groups (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  name         text not null
);

-- Карточка товара (nm_id = артикул WB)
create table products (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  nm_id               bigint not null,          -- артикул Wildberries
  vendor_code         text,                     -- артикул продавца
  title               text,
  brand               text,
  category            text,                     -- предмет/subject
  photo_url           text,
  status              text,                     -- 'Локомотив' и др. пользовательские статусы
  group_id            uuid references product_groups(id) on delete set null,
  cost_price          numeric(12,2),            -- себестоимость (вводит пользователь)
  logistics_cost      numeric(12,2),
  responsible_user_id uuid references profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (store_id, nm_id)
);

-- Остатки по размерам и складам (снимок на дату)
create table stock_snapshots (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  warehouse     text not null,                -- название склада WB
  size          text,                         -- XXS..5XL
  on_stock      integer not null default 0,   -- На складе
  in_transit    integer not null default 0,   -- В пути
  in_production integer not null default 0,   -- В пошиве (вводит пользователь)
  snapshot_date date not null,
  created_at    timestamptz not null default now(),
  unique (product_id, warehouse, size, snapshot_date)
);
