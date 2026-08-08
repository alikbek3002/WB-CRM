-- ─────────────────────────────────────────────────────────────────────────────
-- 0039: Группы товаров — доводим заготовку 0004 до рабочей функции.
--   product_groups (org_id, name) и products.group_id существуют с Фазы 0,
--   но приложением не использовались. Директор/ст. менеджер создают группы
--   («группа Алик», «группа Тимур») и раскидывают по ним товары; на «Товарах»
--   появляется фильтр по группе. Товар состоит максимум в одной группе;
--   удаление группы товары не трогает (FK on delete set null из 0004).
--   RLS уже настроен в 0009: читает org, пишут owner/admin/manager.
-- ─────────────────────────────────────────────────────────────────────────────

alter table product_groups
  add column if not exists created_by uuid references profiles(id) on delete set null,
  add column if not exists created_at timestamptz not null default now();

-- Имена групп внутри организации не дублируем (у insert будет честный 23505)
create unique index if not exists uq_product_groups_org_name
  on product_groups (org_id, name);

-- Фильтр «Товаров» по группе; сгруппированных товаров обычно меньшинство
create index if not exists idx_products_group
  on products (group_id) where group_id is not null;
