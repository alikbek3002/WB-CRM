-- ─────────────────────────────────────────────────────────────────────────────
-- 0020: План продаж WB на период (полугодие) + дневной факт продаж.
--   WB выставляет план на полгода (текущий: со 2 июля). Сумму периода вводит
--   директор — система раскладывает по дням и рисует план/факт как в кабинете.
-- ─────────────────────────────────────────────────────────────────────────────

create table sales_plans (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  store_id     uuid not null references stores(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  amount_rub   numeric(14,2) not null,     -- план продаж на весь период, ₽
  note         text,
  created_by   uuid references profiles(id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (store_id, period_start)
);

create trigger trg_sales_plans_updated_at
  before update on sales_plans
  for each row execute function set_updated_at();

alter table sales_plans enable row level security;
create policy sales_plans_read on sales_plans
  for select using (org_id in (select auth_org_ids()));
create policy sales_plans_write on sales_plans
  for all using (auth_role(org_id) in ('owner','admin','manager'));

-- Продажи по дням (сумма как в кабинете WB — по цене со скидкой продавца)
create or replace function agg_sales_daily(p_store uuid, p_since timestamptz)
returns table(day date, qty bigint, sum_rub numeric)
language sql stable as $$
  select sale_date::date, count(*), coalesce(sum(price_with_disc), 0)
  from raw_sales
  where store_id = p_store and sale_date >= p_since
    and not coalesce(is_return, false)
  group by 1 order by 1;
$$;
