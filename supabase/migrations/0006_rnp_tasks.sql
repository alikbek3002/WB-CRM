-- WB CRM · Миграция 0006: планирование РНП и задачи (раздел 4.5 плана)

-- План по SKU на неделю (то, что вводит пользователь в модуле РНП)
create table rnp_plans (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references products(id) on delete cascade,
  iso_year            smallint not null,
  iso_week            smallint not null check (iso_week between 1 and 53),
  plan_orders         integer,                  -- План заказ (шт)
  plan_sales          integer,                  -- План продаж (шт)
  plan_views          integer,                  -- План показов
  plan_spp            numeric(6,2),             -- плановый СПП %
  giveaways           integer default 0,        -- Раздачи (самовыкупы)
  responsible_user_id uuid references profiles(id) on delete set null,
  note                text,
  updated_at          timestamptz not null default now(),
  unique (product_id, iso_year, iso_week)
);

-- Ручные бенчмарки конкурентов на уровне категории (раздел 6 плана:
-- «% Корзина конкурентов» и т.п. — в MVP ручной ввод)
create table competitor_benchmarks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  category      text not null,
  cart_percent  numeric(6,2),   -- % Корзина конкурентов
  order_percent numeric(6,2),   -- % Заказов конкурентов
  cro_percent   numeric(6,2),   -- % CRO конкурентов
  updated_at    timestamptz not null default now(),
  unique (org_id, category)
);

-- Задачи (для Telegram-бота и модуля Задачи)
create type task_status as enum ('open','in_progress','done','cancelled');
create type task_priority as enum ('low','normal','high','urgent');

create table tasks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  title        text not null,
  description  text,
  status       task_status not null default 'open',
  priority     task_priority not null default 'normal',
  product_id   uuid references products(id) on delete set null,  -- задача может быть привязана к SKU
  assignee_id  uuid references profiles(id) on delete set null,
  created_by   uuid references profiles(id) on delete set null,
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Комментарии к задачам
create table task_comments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  author_id    uuid references profiles(id) on delete set null,
  body         text not null,
  created_at   timestamptz not null default now()
);
