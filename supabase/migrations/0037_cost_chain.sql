-- WB CRM · Миграция 0037: полная себестоимость (отшив + карго + фул-фирма).
--
-- ЗАЧЕМ. Себестоимость до сих пор собиралась только наполовину и в двух местах
-- считала неверно:
--   1) КАРГО СЧИТАЛОСЬ ДВАЖДЫ. Оно входит в products.cost_price при приёмке
--      (api/supplies/[id]/receive) и одновременно попадало в OPEX: оплата карго
--      зеркалится в кассу статьёй «Карго и доставка», а у неё стоял in_pnl=true.
--      У «Закуп товара» защита (in_pnl=false) была, у карго — забыли.
--   2) УСЛУГИ ФУЛ-ФИРМЫ не учитывались НИГДЕ. Таблиц fulfillment* не было
--      вообще: модуль «Фул-фирма» — это срез supplies по статусу, все его поля
--      в штуках. Прибыль на сумму услуг ФФ была завышена.
--   3) ОДНА ПОСТАВКА = ОДИН ТОВАР. Реальное карго везёт несколько артикулов,
--      и карго на них приходилось делить руками.
--
-- Бэкфилл не нужен: supplies/factories/supply_payments/product_cost_history
-- на момент миграции пусты (0 строк), цепочка ни разу не отработала на живых
-- данных. Легаси-поля supplies (product_id/quantity/sewing_cost/received_qty)
-- оставляем nullable — на них ещё смотрит мок-слой, но в расчёте себестоимости
-- они больше не участвуют.

------------------------------------------------------------------------------
-- supply_items — позиции поставки (несколько товаров в одном карго)
-- Отшив у каждой позиции свой; карго и услуги ФФ распределяются между
-- позициями пропорционально принятому количеству (см. backend/data/cost-core.ts).
------------------------------------------------------------------------------

create table supply_items (
  id            uuid primary key default gen_random_uuid(),
  supply_id     uuid not null references supplies(id) on delete cascade,
  product_id    uuid references products(id) on delete set null, -- null — товар ещё не заведён
  title         text not null,                                   -- наименование, как ввели
  quantity      integer not null default 0,                      -- отгружено, шт
  received_qty  integer,                                         -- принято, шт (null — ещё не принимали)
  sewing_cost     numeric(14,2) not null default 0,
  sewing_currency text not null default 'cny' check (sewing_currency in ('cny','uzs','rub')),
  -- Курс фиксируем на позиции: EXCHANGE_RATES в коде — константа, и правка её
  -- задним числом иначе переписала бы себестоимость уже закрытых партий.
  sewing_rate_to_rub numeric(12,4),
  created_at    timestamptz not null default now(),
  unique (supply_id, product_id)
);

create index idx_supply_items_supply   on supply_items (supply_id);
create index idx_supply_items_product  on supply_items (product_id);

------------------------------------------------------------------------------
-- fulfillment_partners — фул-фирма с тарифом за единицу
------------------------------------------------------------------------------

create table fulfillment_partners (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  name              text not null,
  rate_per_unit_rub numeric(12,2) not null default 0,  -- ₽ за единицу приёмки/разбора/упаковки
  note              text,
  archived          boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (org_id, name)
);

create index idx_fulfillment_partners_org on fulfillment_partners (org_id);

------------------------------------------------------------------------------
-- supplies: кто разбирал поставку, во сколько это обошлось, курс карго
------------------------------------------------------------------------------

alter table supplies
  add column fulfillment_partner_id uuid references fulfillment_partners(id) on delete set null,
  -- Фактическая сумма услуг ФФ. null → считаем тариф × принято.
  add column fulfillment_cost_rub   numeric(14,2),
  add column cargo_rate_to_rub      numeric(12,4);

------------------------------------------------------------------------------
-- supply_payments: третий вид оплаты — фул-фирме
------------------------------------------------------------------------------

alter table supply_payments drop constraint supply_payments_kind_check;
alter table supply_payments add constraint supply_payments_kind_check
  check (kind in ('goods','cargo','fulfillment'));

------------------------------------------------------------------------------
-- products: из чего сложилась текущая себестоимость (₽ за единицу)
-- Сумма трёх полей равна cost_price, когда источник — 'supply'. При ручном
-- вводе и импорте разбивки нет: всё лежит в cost_sewing_rub.
------------------------------------------------------------------------------

alter table products
  add column cost_sewing_rub      numeric(12,2) not null default 0,
  add column cost_cargo_rub       numeric(12,2) not null default 0,
  add column cost_fulfillment_rub numeric(12,2) not null default 0;

-- История партий: та же разбивка + сколько штук пришло (для средневзвешенной)
alter table product_cost_history
  add column sewing_rub      numeric(12,2),
  add column cargo_rub       numeric(12,2),
  add column fulfillment_rub numeric(12,2),
  add column qty             integer;

------------------------------------------------------------------------------
-- Статьи расходов: убираем двойной счёт
-- Карго теперь входит в себестоимость единицы, поэтому расходом ПЕРИОДА быть
-- перестаёт — списывается в ОПиУ через себестоимость проданного, как «Закуп
-- товара». Услуги ФФ — по той же логике.
------------------------------------------------------------------------------

update expense_categories
   set in_pnl = false
 where name = 'Карго и доставка';

insert into expense_categories (org_id, name, direction, in_pnl, emoji, sort_order)
select o.id, 'Фулфилмент', 'out', false, '📥', 125
from orgs o
on conflict (org_id, name) do nothing;

------------------------------------------------------------------------------
-- RLS (зеркалит 0013_supply_chain.sql; supply_org() уже определена там)
------------------------------------------------------------------------------

alter table supply_items         enable row level security;
alter table fulfillment_partners enable row level security;

create policy "supply_items: read own org" on supply_items
  for select using (supply_org(supply_id) in (select auth_org_ids()));
create policy "supply_items: managers write" on supply_items
  for all using (auth_role(supply_org(supply_id)) in ('owner','admin','manager'))
  with check (auth_role(supply_org(supply_id)) in ('owner','admin','manager'));

create policy "fulfillment_partners: read own org" on fulfillment_partners
  for select using (org_id in (select auth_org_ids()));
create policy "fulfillment_partners: managers write" on fulfillment_partners
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));
