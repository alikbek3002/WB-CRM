-- WB CRM · Миграция 0009: RLS-политики и RBAC (раздел 5 плана)
-- Изоляция данных по org_id. Роли: owner (Директор), admin, manager (Старший менеджер),
-- analyst, viewer. Запись в raw_* и sync_runs разрешена только service_role (обходит RLS).

------------------------------------------------------------------------------
-- Хелперы
------------------------------------------------------------------------------

-- Список org_id, к которым принадлежит текущий пользователь
create or replace function auth_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from org_members where user_id = auth.uid();
$$;

-- Роль пользователя в конкретной org
create or replace function auth_role(p_org uuid)
returns member_role language sql stable security definer set search_path = public as $$
  select role from org_members where user_id = auth.uid() and org_id = p_org;
$$;

-- org_id магазина (для таблиц, привязанных через store_id)
create or replace function store_org(p_store uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from stores where id = p_store;
$$;

-- org_id товара (для таблиц, привязанных через product_id)
create or replace function product_org(p_product uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select s.org_id from products p join stores s on s.id = p.store_id where p.id = p_product;
$$;

------------------------------------------------------------------------------
-- Включаем RLS на всех пользовательских таблицах
------------------------------------------------------------------------------

alter table orgs                    enable row level security;
alter table profiles                enable row level security;
alter table org_members             enable row level security;
alter table invites                 enable row level security;
alter table stores                  enable row level security;
alter table integration_credentials enable row level security;
alter table product_groups          enable row level security;
alter table products                enable row level security;
alter table stock_snapshots         enable row level security;
alter table raw_orders              enable row level security;
alter table raw_sales               enable row level security;
alter table raw_funnel_daily        enable row level security;
alter table raw_advert_daily        enable row level security;
alter table raw_finance_report      enable row level security;
alter table rnp_plans               enable row level security;
alter table competitor_benchmarks   enable row level security;
alter table tasks                   enable row level security;
alter table task_comments           enable row level security;
alter table ai_insights             enable row level security;
alter table sync_runs               enable row level security;
alter table audit_log               enable row level security;
alter table tariffs                 enable row level security;

------------------------------------------------------------------------------
-- orgs
------------------------------------------------------------------------------

create policy "orgs: read own" on orgs
  for select using (id in (select auth_org_ids()));

create policy "orgs: owner updates" on orgs
  for update using (auth_role(id) = 'owner');

create policy "orgs: owner deletes" on orgs
  for delete using (auth_role(id) = 'owner');

-- Создание org идёт через security definer функцию create_org_with_owner (0011)

------------------------------------------------------------------------------
-- profiles
------------------------------------------------------------------------------

create policy "profiles: own or co-members" on profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1 from org_members m
      where m.user_id = profiles.id and m.org_id in (select auth_org_ids())
    )
  );

create policy "profiles: insert own" on profiles
  for insert with check (id = auth.uid());

create policy "profiles: update own" on profiles
  for update using (id = auth.uid());

------------------------------------------------------------------------------
-- org_members (управление составом — owner/admin; см. также accept_invite в 0011)
------------------------------------------------------------------------------

create policy "org_members: read own org" on org_members
  for select using (org_id in (select auth_org_ids()));

create policy "org_members: admins manage" on org_members
  for all using (auth_role(org_id) in ('owner','admin'))
  with check (auth_role(org_id) in ('owner','admin'));

------------------------------------------------------------------------------
-- invites
------------------------------------------------------------------------------

create policy "invites: admins manage" on invites
  for all using (auth_role(org_id) in ('owner','admin'))
  with check (auth_role(org_id) in ('owner','admin'));

------------------------------------------------------------------------------
-- stores
------------------------------------------------------------------------------

create policy "stores: read own org" on stores
  for select using (org_id in (select auth_org_ids()));

create policy "stores: admins manage" on stores
  for all using (auth_role(org_id) in ('owner','admin'))
  with check (auth_role(org_id) in ('owner','admin'));

------------------------------------------------------------------------------
-- integration_credentials (API-ключи — только owner/admin, раздел 5.1)
------------------------------------------------------------------------------

create policy "credentials: admins only" on integration_credentials
  for all using (auth_role(store_org(store_id)) in ('owner','admin'))
  with check (auth_role(store_org(store_id)) in ('owner','admin'));

------------------------------------------------------------------------------
-- product_groups / products / stock_snapshots
-- (просмотр — все члены org; правка — manager и выше)
------------------------------------------------------------------------------

create policy "product_groups: read own org" on product_groups
  for select using (org_id in (select auth_org_ids()));

create policy "product_groups: managers write" on product_groups
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

create policy "products: read own org" on products
  for select using (store_org(store_id) in (select auth_org_ids()));

create policy "products: managers write" on products
  for all using (auth_role(store_org(store_id)) in ('owner','admin','manager'))
  with check (auth_role(store_org(store_id)) in ('owner','admin','manager'));

create policy "stock: read own org" on stock_snapshots
  for select using (product_org(product_id) in (select auth_org_ids()));

-- Ручной ввод «В пошиве» — manager+; остальные значения пишет сервисный слой
create policy "stock: managers write" on stock_snapshots
  for all using (auth_role(product_org(product_id)) in ('owner','admin','manager'))
  with check (auth_role(product_org(product_id)) in ('owner','admin','manager'));

------------------------------------------------------------------------------
-- raw_* (только чтение; запись — service_role, обходит RLS)
------------------------------------------------------------------------------

create policy "raw_orders: read own org" on raw_orders
  for select using (store_org(store_id) in (select auth_org_ids()));

create policy "raw_sales: read own org" on raw_sales
  for select using (store_org(store_id) in (select auth_org_ids()));

create policy "raw_funnel: read own org" on raw_funnel_daily
  for select using (store_org(store_id) in (select auth_org_ids()));

create policy "raw_advert: read own org" on raw_advert_daily
  for select using (store_org(store_id) in (select auth_org_ids()));

-- Финансы: owner/admin/manager/analyst (viewer — нет, раздел 5.1)
create policy "raw_finance: finance roles" on raw_finance_report
  for select using (auth_role(store_org(store_id)) in ('owner','admin','manager','analyst'));

------------------------------------------------------------------------------
-- rnp_plans (просмотр — все члены; редактирование планов — manager+, раздел 5.1)
------------------------------------------------------------------------------

create policy "rnp_plans: read own org" on rnp_plans
  for select using (product_org(product_id) in (select auth_org_ids()));

create policy "rnp_plans: managers write" on rnp_plans
  for all using (auth_role(product_org(product_id)) in ('owner','admin','manager'))
  with check (auth_role(product_org(product_id)) in ('owner','admin','manager'));

------------------------------------------------------------------------------
-- competitor_benchmarks
------------------------------------------------------------------------------

create policy "benchmarks: read own org" on competitor_benchmarks
  for select using (org_id in (select auth_org_ids()));

create policy "benchmarks: managers write" on competitor_benchmarks
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

------------------------------------------------------------------------------
-- tasks (viewer видит только свои задачи, раздел 5.1)
------------------------------------------------------------------------------

create policy "tasks: read" on tasks
  for select using (
    org_id in (select auth_org_ids())
    and (
      auth_role(org_id) in ('owner','admin','manager','analyst')
      or assignee_id = auth.uid()
      or created_by = auth.uid()
    )
  );

create policy "tasks: create own" on tasks
  for insert with check (
    org_id in (select auth_org_ids()) and created_by = auth.uid()
  );

create policy "tasks: update" on tasks
  for update using (
    org_id in (select auth_org_ids())
    and (
      auth_role(org_id) in ('owner','admin','manager')
      or assignee_id = auth.uid()
      or created_by = auth.uid()
    )
  );

create policy "tasks: delete" on tasks
  for delete using (
    auth_role(org_id) in ('owner','admin','manager') or created_by = auth.uid()
  );

create policy "task_comments: read visible tasks" on task_comments
  for select using (exists (select 1 from tasks t where t.id = task_comments.task_id));

create policy "task_comments: author writes" on task_comments
  for insert with check (
    author_id = auth.uid()
    and exists (select 1 from tasks t where t.id = task_comments.task_id)
  );

create policy "task_comments: author manages" on task_comments
  for update using (author_id = auth.uid());

create policy "task_comments: author deletes" on task_comments
  for delete using (author_id = auth.uid());

------------------------------------------------------------------------------
-- ai_insights / sync_runs / audit_log (запись — сервисный слой)
------------------------------------------------------------------------------

create policy "ai_insights: read own org" on ai_insights
  for select using (org_id in (select auth_org_ids()));

create policy "sync_runs: read own org" on sync_runs
  for select using (store_org(store_id) in (select auth_org_ids()));

create policy "audit_log: admins read" on audit_log
  for select using (auth_role(org_id) in ('owner','admin'));

------------------------------------------------------------------------------
-- tariffs — публичный справочник
------------------------------------------------------------------------------

create policy "tariffs: readable by all" on tariffs
  for select using (true);
