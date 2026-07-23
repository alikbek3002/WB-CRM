-- WB CRM · Миграция 0014: вход через Telegram-бот (логин/пароль → роль → меню)
-- Бот аутентифицирует сотрудника по короткому логину + паролю (Supabase Auth),
-- привязывает telegram_id к профилю и выдаёт меню по роли (RBAC, src/shared/rbac.ts).
-- profiles.telegram_id / telegram_username уже есть (0002) — здесь добавляем короткий
-- логин и таблицу состояния диалога входа. Идемпотентно (if not exists) — db:push
-- накатит только эту миграцию (учёт в _wbcrm_migrations).

------------------------------------------------------------------------------
-- profiles.login — короткий логин для входа в бота (director, marat, aliya…)
-- Уникален; регистр не важен (храним и сравниваем в нижнем регистре).
------------------------------------------------------------------------------

alter table profiles add column if not exists login text;

create unique index if not exists idx_profiles_login on profiles (lower(login));

------------------------------------------------------------------------------
-- telegram_sessions — состояние пошагового входа (ключ = chat_id Telegram).
-- Транзиентное: хранит шаг диалога (idle | await_login | await_password) и
-- введённый логин между сообщениями. Личность после входа — в profiles.telegram_id.
-- Пишется/читается только service_role (бот) — RLS включён без политик (deny-all для anon).
------------------------------------------------------------------------------

create table if not exists telegram_sessions (
  chat_id     bigint primary key,
  data        jsonb  not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table telegram_sessions enable row level security;

------------------------------------------------------------------------------
-- Индекс для поиска профиля по привязанному telegram_id (быстрый авто-вход).
-- Колонка уже unique (0002) → индекс есть; добавляем частичный на случай отсутствия.
------------------------------------------------------------------------------

create index if not exists idx_profiles_telegram_id on profiles (telegram_id)
  where telegram_id is not null;
