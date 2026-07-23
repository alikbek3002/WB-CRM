"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";

// Фильтры дашборда (раздел 11.1 плана). В демо-режиме — один магазин;
// после Фазы 4 значения приходят из БД, состояние — в searchParams.
const FILTERS: { placeholder: string; options: string[] }[] = [
  { placeholder: "Маркетплейсы", options: ["Wildberries"] },
  { placeholder: "Магазины", options: ["Kimono Brand"] },
  { placeholder: "Бренды", options: ["Все бренды", "Kimono Brand"] },
  { placeholder: "Категории", options: ["Все категории", "Костюмы", "Рубашки", "Платья"] },
  { placeholder: "Группы", options: ["Все группы", "Локомотивы", "Новинки"] },
  { placeholder: "Артикулы", options: ["Все артикулы"] },
];

const PERIODS = ["7 дней", "14 дней", "30 дней", "Квартал", "Год"];

export function FiltersBar() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {FILTERS.map((f) => (
        <Select key={f.placeholder} defaultValue={f.options[0]}>
          <SelectTrigger size="sm" className="w-auto min-w-32 text-xs">
            <SelectValue placeholder={f.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {f.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      <div className="ml-auto">
        <Select defaultValue="30 дней">
          <SelectTrigger size="sm" className="w-auto min-w-28 text-xs">
            <SelectValue placeholder="Период" />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
