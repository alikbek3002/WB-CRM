"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import { Label } from "@/frontend/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";
import { formatNumber } from "@/shared/format";

export type FilterProduct = {
  id: string;
  title: string;
  category: string;
  brand: string;
  stockQty: number;
};

// Каскад фильтров остатков: вид товара (категория WB) → бренд → конкретный
// товар. Выбор пишется в URL — страница показывает список товаров вида или
// матрицу выбранного товара.
export function StockFilters({
  products,
  category,
  brand,
  productId,
}: {
  products: FilterProduct[];
  category: string; // "all" | категория
  brand: string; // "all" | бренд
  productId: string | null;
}) {
  const router = useRouter();

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      if (!p.category || p.category === "—") continue;
      map.set(p.category, (map.get(p.category) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [products]);

  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.brand && p.brand !== "—") set.add(p.brand);
    }
    return [...set].sort();
  }, [products]);

  // Товары под текущие фильтры (для селекта «Товар»)
  const filtered = useMemo(
    () =>
      products
        .filter(
          (p) =>
            (category === "all" || p.category === category) &&
            (brand === "all" || p.brand === brand),
        )
        .sort((a, b) => b.stockQty - a.stockQty),
    [products, category, brand],
  );

  function push(next: { category?: string; brand?: string; product?: string | null }) {
    const c = next.category ?? category;
    const b = next.brand ?? brand;
    const p = next.product === undefined ? productId : next.product;
    const params = new URLSearchParams();
    if (c !== "all") params.set("category", c);
    if (b !== "all") params.set("brand", b);
    if (p) params.set("product", p);
    const qs = params.toString();
    router.push(qs ? `/stocks?${qs}` : "/stocks");
  }

  const hasFilters = category !== "all" || brand !== "all" || productId;

  // Подписи значений для триггеров (иначе Select показывает сырое value)
  const categoryItems = {
    all: "Все виды",
    ...Object.fromEntries(categories.map(([c, n]) => [c, `${c} · ${n}`])),
  };
  const brandItems = {
    all: "Все бренды",
    ...Object.fromEntries(brands.map((b) => [b, b])),
  };
  const productItems = {
    none: "Все товары вида",
    ...Object.fromEntries(
      filtered.map((p) => [
        p.id,
        p.title.length > 46 ? `${p.title.slice(0, 46)}…` : p.title,
      ]),
    ),
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid w-44 gap-1.5">
        <Label className="text-xs text-muted-foreground">Вид товара</Label>
        <Select
          value={category}
          items={categoryItems}
          onValueChange={(v) => v && push({ category: v, product: null })}
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
          value={brand}
          items={brandItems}
          onValueChange={(v) => v && push({ brand: v, product: null })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все бренды</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid min-w-64 flex-1 gap-1.5 sm:max-w-md">
        <Label className="text-xs text-muted-foreground">
          Товар · {formatNumber(filtered.length)}
        </Label>
        <Select
          value={productId ?? "none"}
          items={productItems}
          onValueChange={(v) => v && push({ product: v === "none" ? null : v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Все товары вида</SelectItem>
            {filtered.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.title.length > 46 ? `${p.title.slice(0, 46)}…` : p.title} ·{" "}
                {formatNumber(p.stockQty)} шт
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters && (
        <Button size="sm" variant="outline" onClick={() => router.push("/stocks")}>
          <X className="size-3.5" />
          Сбросить
        </Button>
      )}
    </div>
  );
}
