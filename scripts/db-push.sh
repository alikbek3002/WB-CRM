#!/usr/bin/env bash
# Применяет SQL-миграции WB CRM к базе Supabase через psql.
# Инкрементально и идемпотентно: помнит применённые файлы в таблице
# _wbcrm_migrations и пропускает их. Можно запускать повторно и добавлять
# новые миграции (0012, 0013 …) — накатятся только новые.
#
# Использует SUPABASE_DB_URL из .env.local.
# Запуск:  npm run db:push
#
# Где взять SUPABASE_DB_URL: Supabase Dashboard → Connect (или Project Settings →
# Database) → строка "Session pooler" или "Direct connection", порт 5432
# (НЕ 6543 — transaction pooler не подходит для миграций/DDL).

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "✗ SUPABASE_DB_URL не задан в .env.local"
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "✗ Не найден psql. Установи: brew install libpq (и добавь в PATH)"
  exit 1
fi

PSQL=(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q)

# Таблица учёта применённых миграций
"${PSQL[@]}" -c "create table if not exists _wbcrm_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);" >/dev/null

echo "Проверяю миграции…"
applied=0
skipped=0
for f in supabase/migrations/*.sql; do
  base="$(basename "$f")"
  exists="$("${PSQL[@]}" -tAc "select 1 from _wbcrm_migrations where filename = '$base'")"
  if [ "$exists" = "1" ]; then
    echo "· пропуск  $base (уже применена)"
    skipped=$((skipped + 1))
    continue
  fi
  echo "→ применяю $base"
  # каждая миграция — в одной транзакции (-1); при ошибке откат и стоп
  "${PSQL[@]}" -1 -f "$f"
  "${PSQL[@]}" -c "insert into _wbcrm_migrations (filename) values ('$base')" >/dev/null
  applied=$((applied + 1))
done

echo "✓ Готово. Применено новых: $applied, пропущено: $skipped."
if [ "$applied" -gt 0 ]; then
  echo "  Дальше — наполнить демо-данными:  npm run db:seed"
fi
