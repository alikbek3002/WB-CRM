#!/usr/bin/env bash
# Обнуляет ДАННЫЕ в базе WB CRM (схема и справочник тарифов остаются).
# Удаляет и демо-пользователей Auth (@demo.wbcrm).
# Запуск:  npm run db:reset      (потом обычно  npm run db:seed)
#
# ⚠️  Стирает ВСЕ строки данных. Использовать осознанно.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
fi
if [ -z "${SUPABASE_DB_URL:-}" ]; then echo "✗ SUPABASE_DB_URL не задан в .env.local"; exit 1; fi
if ! command -v psql >/dev/null 2>&1; then echo "✗ Не найден psql"; exit 1; fi

echo "Обнуляю данные…"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
truncate table
  raw_orders, raw_sales, raw_funnel_daily, raw_advert_daily, raw_finance_report,
  stock_snapshots, rnp_plans, competitor_benchmarks,
  task_comments, tasks, ai_insights, sync_runs, audit_log,
  telegram_sessions,
  wb_distributions, supply_payments, supplies, factories,
  integration_credentials, products, product_groups, stores,
  org_members, invites, orgs
  restart identity cascade;

-- демо-пользователи Auth (каскадом удалятся их profiles)
delete from auth.users where email like '%@demo.wbcrm';
SQL

echo "✓ База обнулена (тарифы и схема на месте). Дальше:  npm run db:seed"
