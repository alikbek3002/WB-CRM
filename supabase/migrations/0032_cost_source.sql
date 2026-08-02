-- 0032: происхождение себестоимости + история партий.
-- Себестоимости нет в WB API — это данные продавца. Три источника заполнения:
--   manual — руками (форма товара, ИИ-ассистент);
--   import — массовый импорт из Excel/CSV;
--   supply — автоматически из приёмки поставки: (отшивка+карго)/принято, ₽
--            (политика «последняя партия перезаписывает» — подтверждена).
-- product_cost_history хранит каждую смену цены: видно, из какой партии цифра.

alter table products
  add column cost_price_source text not null default 'manual'
    check (cost_price_source in ('manual', 'import', 'supply')),
  add column cost_price_updated_at timestamptz;

create table product_cost_history (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  cost_price  numeric(12,2) not null,
  source      text not null check (source in ('manual', 'import', 'supply')),
  supply_id   uuid references supplies(id) on delete set null,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index idx_product_cost_history_product
  on product_cost_history (product_id, created_at desc);

-- RLS (зеркалит 0009: чтение — члены org товара; запись идёт через service_role)
alter table product_cost_history enable row level security;

create policy "product_cost_history: read own org" on product_cost_history
  for select using (
    exists (
      select 1 from products p
      where p.id = product_id
        and store_org(p.store_id) in (select auth_org_ids())
    )
  );

create policy "product_cost_history: managers write" on product_cost_history
  for all using (
    exists (
      select 1 from products p
      where p.id = product_id
        and auth_role(store_org(p.store_id)) in ('owner', 'admin', 'manager')
    )
  )
  with check (
    exists (
      select 1 from products p
      where p.id = product_id
        and auth_role(store_org(p.store_id)) in ('owner', 'admin', 'manager')
    )
  );
