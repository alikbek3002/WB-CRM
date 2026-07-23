-- WB CRM · Миграция 0003: магазины и API-ключи (раздел 4.2 плана)

-- Подключённый магазин WB (у одной org может быть несколько)
create table stores (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  marketplace  text not null default 'wildberries',  -- задел на Ozon и др.
  name         text not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Зашифрованные API-ключи. Сам токен НИКОГДА не хранится открытым текстом:
-- секрет лежит в Supabase Vault (vault.secrets), здесь только ссылка на него.
create table integration_credentials (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  provider        text not null check (provider in ('wb','claude','telegram')),
  vault_secret_id uuid not null,          -- id секрета в vault.secrets
  scopes          text[],                 -- категории WB-токена (content, statistics, ...)
  status          text not null default 'pending'
                  check (status in ('pending','valid','invalid','revoked')),
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (store_id, provider)
);
