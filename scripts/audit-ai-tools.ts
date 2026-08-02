// Диф-проверка каталога инструментов ИИ по ролям:
//   npx tsx scripts/audit-ai-tools.ts
// Печатает, какие инструменты видит каждая роль — быстро ловит случайные
// расширения/сужения прав после правок CATALOG или матрицы RBAC.

import { toolsForRole } from "../src/backend/ai/tools";
import { ROLE_LABELS, type MemberRole } from "../src/shared/rbac";

const roles = Object.keys(ROLE_LABELS) as MemberRole[];

for (const role of roles) {
  const tools = toolsForRole(role);
  console.log(`\n=== ${role} (${ROLE_LABELS[role]}) — ${tools.length} инструментов ===`);
  console.log(tools.map((t) => t.name).join(", "));
}

// Сводная матрица: инструмент → роли
const all = new Map<string, string[]>();
for (const role of roles) {
  for (const t of toolsForRole(role)) {
    all.set(t.name, [...(all.get(t.name) ?? []), role]);
  }
}
console.log(`\n=== Матрица (${all.size} инструментов) ===`);
for (const [name, rs] of [...all.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${name.padEnd(26)} ${rs.join(", ")}`);
}
