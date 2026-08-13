// Правила регламента — общие для API и интерфейса, чтобы кнопка «Изменить» и
// проверка на сервере не разъезжались.

import type { MemberRole } from "./rbac";

export const DUTY_WEEKDAYS = [
  { value: 1, short: "пн", label: "понедельник" },
  { value: 2, short: "вт", label: "вторник" },
  { value: 3, short: "ср", label: "среда" },
  { value: 4, short: "чт", label: "четверг" },
  { value: 5, short: "пт", label: "пятница" },
  { value: 6, short: "сб", label: "суббота" },
  { value: 7, short: "вс", label: "воскресенье" },
] as const;

export function weekdayLabel(weekday: number | null): string {
  return DUTY_WEEKDAYS.find((d) => d.value === weekday)?.label ?? "—";
}

// «Ежедневно до 11:00» / «По вторникам до 17:00» — человеческая формулировка
// расписания. Раньше на экране висело «weekly/2», и это приходилось расшифровывать.
export function scheduleLabel(
  frequency: "daily" | "weekly",
  weekday: number | null,
  dueTime: string,
): string {
  const time = String(dueTime).slice(0, 5);
  if (frequency === "daily") return `Ежедневно до ${time}`;
  const day = DUTY_WEEKDAYS.find((d) => d.value === weekday);
  return day ? `По ${day.short}. до ${time}` : `Раз в неделю до ${time}`;
}

// Чей это регламент: конкретного сотрудника или всех с такой ролью
export type DutyTarget = {
  assigneeUserId: string | null;
  role: string;
};

// «Свой регламент» — тот, по которому задачи падают лично мне: либо назначен
// поимённо, либо без имени, но на мою роль (тогда наряд создаётся и мне).
export function isOwnDuty(
  target: DutyTarget,
  me: { userId: string; role: MemberRole },
): boolean {
  if (target.assigneeUserId) return target.assigneeUserId === me.userId;
  return target.role === me.role;
}

// Кто может править конкретную обязанность.
// Директор (owner) и админ — любую, включая свою: это их инструмент управления.
// Старший менеджер — чужие, но не свою: правка себе превращает регламент
// в самоназначение.
export function canEditDutyTemplate(
  target: DutyTarget,
  me: { userId: string; role: MemberRole },
): boolean {
  if (me.role === "owner" || me.role === "admin") return true;
  if (me.role !== "manager") return false;
  return !isOwnDuty(target, me);
}

// Почему кнопка недоступна — текст показываем прямо в строке регламента
export const OWN_DUTY_HINT = "свой регламент — меняет только директор";
