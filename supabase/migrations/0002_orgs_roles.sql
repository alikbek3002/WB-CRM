-- WB CRM · Миграция 0002: организации, профили, роли, приглашения (раздел 4.1 плана)

-- Организация (рабочее пространство / тенант)
create table orgs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  plan_code    text not null default 'trial',   -- FK на tariffs добавляется в 0008
  created_at   timestamptz not null default now()
);

-- Профиль пользователя (связан с auth.users Supabase)
create table profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text,
  telegram_id       bigint unique,           -- для привязки Telegram
  telegram_username text,
  created_at        timestamptz not null default now()
);

-- Роли пользователя в организации
-- owner = Директор, admin = Администратор, manager = Старший менеджер,
-- analyst = Аналитик, viewer = Наблюдатель (матрица прав — раздел 5.1 плана)
create type member_role as enum ('owner','admin','manager','analyst','viewer');

create table org_members (
  org_id       uuid not null references orgs(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  role         member_role not null default 'viewer',
  created_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Приглашения в команду
create table invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  email        text not null,
  role         member_role not null default 'viewer',
  token        text not null unique,
  accepted_at  timestamptz,
  expires_at   timestamptz not null default now() + interval '7 days'
);
