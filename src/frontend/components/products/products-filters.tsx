"use client";

import { useMemo } from "react";
import { Search, X } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Input } from "@/frontend/components/ui/input";
import { Label } from "@/frontend/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";
import { formatNumber } from "@/shared/format";
import type { ProductListItem } from "@/shared/types";

// Как сортировать список. Значения совпадают с ключами SORT_LABELS ниже.
export type SortKey =
  | "sales"
  | "stock"
  | "cover"
  | "margin"
  | "price"
  | "title";

export const SORT_LABELS: Record<SortKey, string> = {
  sales: "Продажи за 30 дней",
  stock: "Остаток",
  cover: "На сколько хватит",
  margin: "Маржа",
  price: "Цена",
  title: "Название",
};

export type ProductFilters = {
  query: string;
  category: string; // "all" | вид товара
  brand: string; // "all" | бренд
  sort: SortKey;
  weakOnly: boolean;
};

export const EMPTY_FILTERS: ProductFilters = {
  query: "",
  category: "all",
  brand: "all",
  sort: "sales",
  weakOnly: false,
};

// Товар подходит под строку поиска: название, артикул продавца или номенклатура
// WB. Ищем по всем трём сразу — менеджеры одинаково часто ищут и по названию,
// и по вставленному из кабинета nmID.
function matchesQuery(p: ProductListItem, q: string): boolean {
  if (!q) return true;
  return (
    p.title.toLowerCase().includes(q) ||
    p.vendorCode.toLowerCase().includes(q) ||
    String(p.nmId).includes(q) ||
    p.brand.toLowerCase().includes(q)
  );
}

/** Отбор + сортировка. Вынесено сюда, чтобы вид (карточки/список) не дублировал логику. */
export function applyFilters(
  products: ProductListItem[],
  f: ProductFilters,
): ProductListItem[] {
  const q = f.query.trim().toLowerCase();

  const rows = products.filter(
    (p) =>
      matchesQuery(p, q) &&
      (f.category === "all" || p.category === f.category) &&
      (f.brand === "all" || p.brand === f.brand) &&
      (!f.weakOnly || p.isWeak),
  );

  const by = (v: number | null) => (v === null ? -Infinity : v);
  return [...rows].sort((a, b) => {
    switch (f.sort) {
      case "stock":
        return b.stockQty - a.stockQty;
      // «Хватит на» — сначала то, что вот-вот кончится; товары без продаж
      // (daysOfCover = null) уводим в конец, иначе они займут весь верх.
      case "cover":
        return (
          (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) -
          (b.daysOfCover ?? Number.MAX_SAFE_INTEGER)
        );
      case "margin":
        return by(b.econ?.marginPct ?? null) - by(a.econ?.marginPct ?? null);
      case "price":
        return by(b.priceDiscountedWb) - by(a.priceDiscountedWb);
      case "title":
        return a.title.localeCompare(b.title, "ru");
      case "sales":
      default:
        return b.salesRank30d - a.salesRank30d;
    }
  });
}

export function ProductsFilters({
  products,
  shown,
  filters,
  onChange,
  right,
}: {
  products: ProductListItem[];
  shown: number;
  filters: ProductFilters;
  onChange: (next: ProductFilters) => void;
  right?: React.ReactNode; // импорт себестоимости + переключатель карточки/список
}) {
  const q = filters.query.trim().toLowerCase();

  // Список значений строится по ВСЕМ товарам — иначе, выбрав вид, нельзя было бы
  // переключиться на другой: список схлопнулся бы до текущего. А счётчик рядом
  // показывает, сколько останется с учётом ОСТАЛЬНЫХ фильтров (кроме своего) —
  // тогда «Пижамы · 51» совпадает с «Показано 51», а не расходится с ним.
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      if (!p.category || p.category === "—") continue;
      const fits =
        matchesQuery(p, q) &&
        (filters.brand === "all" || p.brand === filters.brand) &&
        (!filters.weakOnly || p.isWeak);
      if (!map.has(p.category)) map.set(p.category, 0);
      if (fits) map.set(p.category, (map.get(p.category) ?? 0) + 1);
    }
    // Пустые виды прячем — при поиске «пижама» показывать ещё 18 строк «· 0»
    // бессмысленно. Выбранный оставляем всегда, иначе он пропадёт из списка
    // вместе с возможностью его снять.
    return [...map.entries()]
      .filter(([c, n]) => n > 0 || c === filters.category)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  }, [products, q, filters.brand, filters.weakOnly, filters.category]);

  const brands = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      if (!p.brand || p.brand === "—") continue;
      const fits =
        matchesQuery(p, q) &&
        (filters.category === "all" || p.category === filters.category) &&
        (!filters.weakOnly || p.isWeak);
      if (!map.has(p.brand)) map.set(p.brand, 0);
      if (fits) map.set(p.brand, (map.get(p.brand) ?? 0) + 1);
    }
    return [...map.entries()]
      .filter(([b, n]) => n > 0 || b === filters.brand)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  }, [products, q, filters.category, filters.weakOnly, filters.brand]);

  // «Слабые» — сколько их среди подходящих под остальные фильтры
  const weakCount = useMemo(
    () =>
      products.filter(
        (p) =>
          p.isWeak &&
          matchesQuery(p, q) &&
          (filters.category === "all" || p.category === filters.category) &&
          (filters.brand === "all" || p.brand === filters.brand),
      ).length,
    [products, q, filters.category, filters.brand],
  );

  const dirty =
    filters.query !== "" ||
    filters.category !== "all" ||
    filters.brand !== "all" ||
    filters.weakOnly ||
    filters.sort !== EMPTY_FILTERS.sort;

  const set = (patch: Partial<ProductFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="space-y-2.5">
      {/* Первая строка целиком под фильтры: иначе кнопки вида отжимают их и
          «Бренд» с «Сортировкой» переносятся на второй ряд поодиночке. */}
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="grid min-w-56 flex-1 gap-1.5 sm:max-w-xs">
          <Label className="text-xs text-muted-foreground">Поиск</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="Название, артикул или номер WB"
              className="pl-8"
              aria-label="Поиск по товарам"
            />
          </div>
        </div>

        <div className="grid w-48 gap-1.5">
          <Label className="text-xs text-muted-foreground">Вид товара</Label>
          <Select
            value={filters.category}
            onValueChange={(v) => v && set({ category: String(v) })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все виды</SelectItem>
              {categories.map(([c, n]) => (
                <SelectItem key={c} value={c}>
                  {c} · {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid w-40 gap-1.5">
          <Label className="text-xs text-muted-foreground">Бренд</Label>
          <Select
            value={filters.brand}
            onValueChange={(v) => v && set({ brand: String(v) })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все бренды</SelectItem>
              {brands.map(([b, n]) => (
                <SelectItem key={b} value={b}>
                  {b} · {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid w-48 gap-1.5">
          <Label className="text-xs text-muted-foreground">Сортировка</Label>
          <Select
            value={filters.sort}
            onValueChange={(v) => v && set({ sort: v as SortKey })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SORT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {dirty && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange(EMPTY_FILTERS)}
            aria-label="Сбросить фильтры"
          >
            <X className="size-3.5" />
            Сбросить
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {shown === products.length
            ? `${formatNumber(products.length)} товаров`
            : `Показано ${formatNumber(shown)} из ${formatNumber(products.length)}`}
        </span>

        {weakCount > 0 && (
          <Badge
            role="button"
            tabIndex={0}
            onClick={() => set({ weakOnly: !filters.weakOnly })}
            onKeyDown={(e) => e.key === "Enter" && set({ weakOnly: !filters.weakOnly })}
            variant={filters.weakOnly ? "default" : "outline"}
            className={`cursor-pointer text-[10px] ${
              filters.weakOnly ? "" : "border-red-500/50 text-red-400"
            }`}
          >
            слабые · {weakCount}
          </Badge>
        )}

        {filters.category !== "all" && (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            {filters.category}
            <X
              role="button"
              tabIndex={0}
              aria-label="Убрать фильтр по виду"
              onClick={() => set({ category: "all" })}
              onKeyDown={(e) => e.key === "Enter" && set({ category: "all" })}
              className="size-3 cursor-pointer"
            />
          </Badge>
        )}
        {filters.brand !== "all" && (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            {filters.brand}
            <X
              role="button"
              tabIndex={0}
              aria-label="Убрать фильтр по бренду"
              onClick={() => set({ brand: "all" })}
              onKeyDown={(e) => e.key === "Enter" && set({ brand: "all" })}
              className="size-3 cursor-pointer"
            />
          </Badge>
        )}

        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
    </div>
  );
}
