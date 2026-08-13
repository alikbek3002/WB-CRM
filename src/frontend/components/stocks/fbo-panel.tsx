import Link from "next/link";
import { ImageOff } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { StockFilters } from "@/frontend/components/stocks/stock-filters";
import { formatNumber, formatSom } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { ProductListItem, StocksOverview, WbIncomeGroup } from "@/shared/types";
import { getProductStocks, getProductWarehouseOrders } from "@/backend/data";

// Цвет запаса: <14 дн — критично, <30 — предупреждение, дальше — норма
function coverClass(days: number | null): string {
  if (days === null) return "text-muted-foreground/60";
  if (days < 14) return "text-red-400";
  if (days < 30) return "text-amber-400";
  return "text-emerald-400";
}

// Вкладка FBO — остатки на складах WB (перенос прежней страницы «Остатки»
// один в один): фильтры вид → бренд → товар в URL, обзор складов с runway,
// матрица склад × размер и поставки FBW.
export async function FboPanel({
  overview,
  products,
  wbIncomes,
  category,
  brand,
  productId,
}: {
  overview: StocksOverview;
  products: ProductListItem[];
  wbIncomes: WbIncomeGroup[];
  category: string;
  brand: string;
  productId: string | null;
}) {
  const filterProducts = products.map((p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    brand: p.brand,
    stockQty: p.stockQty,
  }));

  const selected = productId
    ? (products.find((p) => p.id === productId) ?? null)
    : null;
  const [productRows, productOrdersByWh] = selected
    ? await Promise.all([
        getProductStocks(selected.id),
        getProductWarehouseOrders(selected.nmId),
      ])
    : [[], new Map<string, number>()];

  // Товары под фильтрами (список вида, когда конкретный товар не выбран)
  const listed = products
    .filter(
      (p) =>
        (category === "all" || p.category === category) &&
        (brand === "all" || p.brand === brand),
    )
    .sort((a, b) => b.stockQty - a.stockQty);
  const listedQty = listed.reduce((t, p) => t + p.stockQty, 0);
  const filtersActive = category !== "all" || brand !== "all";

  // Матрица склад × размер выбранного товара
  const sizes = [...new Set(productRows.map((r) => r.size))].sort((a, b) =>
    a.localeCompare(b, "ru", { numeric: true }),
  );
  const byWarehouse = new Map<string, Map<string, number>>();
  let productTransit = 0;
  for (const r of productRows) {
    if (r.warehouse === "В пути (WB)") {
      productTransit += r.inTransit;
      continue;
    }
    const row = byWarehouse.get(r.warehouse) ?? new Map<string, number>();
    row.set(r.size, (row.get(r.size) ?? 0) + r.onStock);
    byWarehouse.set(r.warehouse, row);
  }
  const matrixRows = [...byWarehouse.entries()]
    .map(([warehouse, cells]) => {
      const total = [...cells.values()].reduce((t, v) => t + v, 0);
      const orders30d = productOrdersByWh.get(warehouse) ?? 0;
      return {
        warehouse,
        cells,
        total,
        orders30d,
        daysOfCover: orders30d > 0 ? Math.round(total / (orders30d / 30)) : null,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  const productTotal = matrixRows.reduce((t, r) => t + r.total, 0);
  const productOrders30d = matrixRows.reduce((t, r) => t + r.orders30d, 0);
  const productCover =
    productOrders30d > 0 ? Math.round(productTotal / (productOrders30d / 30)) : null;

  const maxWh = overview.warehouses[0]?.qty ?? 0;

  const kpis = [
    { label: "Всего на складах WB", value: formatNumber(overview.totalQty) + " шт" },
    { label: "Складов", value: String(overview.warehouses.length) },
    { label: "В пути (WB)", value: formatNumber(overview.inTransitQty) + " шт" },
    { label: "Товаров с остатком", value: String(overview.productsWithStock) },
  ];

  // Ссылка на товар с сохранением фильтров
  const productHref = (id: string) => {
    const p = new URLSearchParams();
    if (category !== "all") p.set("category", category);
    if (brand !== "all") p.set("brand", brand);
    p.set("product", id);
    return `/stocks?${p.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className="text-2xl font-semibold tabular-nums">{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <StockFilters
        products={filterProducts}
        category={category}
        brand={brand}
        productId={productId}
      />

      {selected ? (
        // ── Матрица выбранного товара: склад × размер ──
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-3 text-sm">
              {selected.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.photoUrl}
                  alt=""
                  className="h-14 w-10 rounded-md border border-border/60 object-cover"
                />
              ) : (
                <span className="flex h-14 w-10 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
                  <ImageOff className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block">{selected.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
                  <span>арт. {selected.nmId}</span>
                  <span>{selected.category}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {formatNumber(productTotal)} шт на складах
                  </Badge>
                  {productTransit > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      в пути {formatNumber(productTransit)} шт
                    </Badge>
                  )}
                  {productCover !== null && (
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", coverClass(productCover))}
                    >
                      хватит на ~{formatNumber(productCover)} дн
                    </Badge>
                  )}
                </span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0 pb-0">
            {matrixRows.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                На складах WB этого товара сейчас нет.
              </p>
            ) : (
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-normal">Склад</th>
                    {sizes.map((s) => (
                      <th key={s} className="px-2 py-2 text-right font-normal">
                        {s}
                      </th>
                    ))}
                    <th className="px-4 py-2 text-right font-medium">Σ</th>
                    <th className="px-3 py-2 text-right font-normal">Заказов/30д</th>
                    <th className="px-4 py-2 text-right font-normal">Хватит на</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.map((row) => (
                    <tr key={row.warehouse} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2">{row.warehouse}</td>
                      {sizes.map((s) => {
                        const v = row.cells.get(s) ?? 0;
                        return (
                          <td
                            key={s}
                            className={cn(
                              "px-2 py-2 text-right tabular-nums",
                              v === 0 && "text-muted-foreground/40",
                            )}
                          >
                            {v}
                          </td>
                        );
                      })}
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {formatNumber(row.total)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {row.orders30d > 0 ? formatNumber(row.orders30d) : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-right tabular-nums",
                          coverClass(row.daysOfCover),
                        )}
                      >
                        {row.daysOfCover !== null ? `${formatNumber(row.daysOfCover)} дн` : "—"}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-muted/20">
                    <td className="px-4 py-2 font-medium">Итого</td>
                    {sizes.map((s) => (
                      <td key={s} className="px-2 py-2 text-right font-medium tabular-nums">
                        {formatNumber(
                          matrixRows.reduce((t, r) => t + (r.cells.get(s) ?? 0), 0),
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">
                      {formatNumber(productTotal)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {productOrders30d > 0 ? formatNumber(productOrders30d) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2 text-right font-medium tabular-nums",
                        coverClass(productCover),
                      )}
                    >
                      {productCover !== null ? `${formatNumber(productCover)} дн` : "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      ) : filtersActive ? (
        // ── Список товаров выбранного вида/бренда ──
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              {category !== "all" ? category : "Все виды"}
              {brand !== "all" && (
                <Badge variant="secondary" className="text-[10px]">
                  {brand}
                </Badge>
              )}
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {formatNumber(listed.length)} товаров ·{" "}
                {formatNumber(listedQty)} шт на складах
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {listed.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Товаров под эти фильтры нет.
              </p>
            )}
            {listed.map((p) => (
              <Link
                key={p.id}
                href={productHref(p.id)}
                className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2 transition hover:border-border hover:bg-muted/30"
              >
                {p.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.photoUrl}
                    alt=""
                    loading="lazy"
                    className="h-12 w-9 shrink-0 rounded border border-border/60 object-cover"
                  />
                ) : (
                  <span className="flex h-12 w-9 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/40 text-muted-foreground">
                    <ImageOff className="size-4" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    арт. {p.nmId}
                    {p.priceDiscountedWb !== null && ` · ${formatSom(p.priceDiscountedWb)}`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-medium tabular-nums">
                    {formatNumber(p.stockQty)} шт
                  </span>
                  {p.daysOfCover !== null && (
                    <span
                      className={cn(
                        "block text-xs tabular-nums",
                        p.daysOfCover < 14
                          ? "text-red-400"
                          : p.daysOfCover < 30
                            ? "text-amber-400"
                            : "text-muted-foreground",
                      )}
                    >
                      хватит на {p.daysOfCover} дн
                    </span>
                  )}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      ) : (
        // ── Обзор складов (фильтры не выбраны) ──
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Все склады</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {overview.warehouses.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Остатков пока нет — появятся после синхронизации WB.
              </p>
            )}
            {overview.warehouses.map((w) => (
              <div key={w.warehouse} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm">{w.warehouse}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/40">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
                    style={{ width: `${maxWh ? Math.max(2, (w.qty / maxWh) * 100) : 0}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                  {formatNumber(w.qty)}
                </span>
                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {overview.totalQty
                    ? ((w.qty / overview.totalQty) * 100).toFixed(1)
                    : "0.0"}
                  %
                </span>
                <span
                  className={cn(
                    "w-24 shrink-0 text-right text-xs tabular-nums",
                    coverClass(w.daysOfCover),
                  )}
                >
                  {w.daysOfCover !== null
                    ? `~${formatNumber(w.daysOfCover)} дн`
                    : "нет заказов"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!selected && !filtersActive && wbIncomes.length > 0 && (
        // ── Поставки FBW: что и когда приняли склады WB (raw_incomes) ──
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Поставки на склады WB
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                последние приёмки за 90 дней
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0 pb-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-normal">Поставка</th>
                  <th className="px-2 py-2 text-left font-normal">Склад</th>
                  <th className="px-2 py-2 text-left font-normal">Товары</th>
                  <th className="px-2 py-2 text-right font-normal">Принято, шт</th>
                  <th className="px-4 py-2 text-right font-normal">Статус</th>
                </tr>
              </thead>
              <tbody>
                {wbIncomes.map((g) => (
                  <tr key={g.incomeId} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2">
                      <span className="block font-medium">№ {g.incomeId}</span>
                      <span className="block text-xs text-muted-foreground">
                        {g.date}
                        {g.dateClose && g.dateClose !== g.date && ` → ${g.dateClose}`}
                      </span>
                    </td>
                    <td className="px-2 py-2">{g.warehouse}</td>
                    <td className="max-w-72 px-2 py-2 text-xs text-muted-foreground">
                      {g.items.map((i) => i.title).join(", ")}
                      {g.positions > g.items.length &&
                        ` и ещё ${g.positions - g.items.length}`}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(g.totalQty)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Badge variant="secondary" className="text-[10px]">
                        {g.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
