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
import type { FbsStocksView, ProductListItem } from "@/shared/types";

// Цвет запаса — как на FBO: <14 дн — критично, <30 — предупреждение
function coverClass(days: number | null): string {
  if (days === null) return "text-muted-foreground/60";
  if (days < 14) return "text-red-400";
  if (days < 30) return "text-amber-400";
  return "text-emerald-400";
}

// Вкладка FBS — остатки личных складов (marketplace-api) в том же сценарии,
// что FBO: каскад фильтров вид → бренд → товар в URL (плюс tab=fbs), обзор
// складов, список товаров с «хватит на» и матрица «склад × размер» выбранного
// товара. Заказы WB не привязаны к личному складу (в них только СЦ), поэтому
// «хватит на» считаем по общему темпу продаж товара за 30 дней — той же
// формулой, что в списке товаров и на FBO.
export function FbsPanel({
  view,
  products,
  category,
  brand,
  productId,
}: {
  view: FbsStocksView;
  products: ProductListItem[];
  category: string;
  brand: string;
  productId: string | null;
}) {
  const { warehouses, products: fbsProducts, totalQty, snapshotDate } = view;

  if (!snapshotDate) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Остатков FBS пока нет — появятся после синхронизации WB
          (Интеграции → «Синхронизировать»).
        </CardContent>
      </Card>
    );
  }

  // Справочник товара (категория/бренд/цена/темп продаж) — из общего списка,
  // он уже загружен страницей: ни одного лишнего запроса
  const infoById = new Map(products.map((p) => [p.id, p]));
  const rows = fbsProducts.map((f) => {
    const info = infoById.get(f.productId);
    const sales30d = info?.salesRank30d ?? 0;
    return {
      ...f,
      category: info?.category ?? "—",
      brand: info?.brand ?? "—",
      priceDiscountedWb: info?.priceDiscountedWb ?? null,
      sales30d,
      daysOfCover:
        sales30d > 0 ? Math.round(f.totalQty / (sales30d / 30)) : null,
    };
  });

  const filtersActive = category !== "all" || brand !== "all";
  const listed = rows.filter(
    (r) =>
      (category === "all" || r.category === category) &&
      (brand === "all" || r.brand === brand),
  );
  const listedQty = listed.reduce((t, r) => t + r.totalQty, 0);

  // В селекты — только товары с FBS-остатком, количества тоже FBS
  const filterProducts = rows.map((r) => ({
    id: r.productId,
    title: r.title,
    category: r.category,
    brand: r.brand,
    stockQty: r.totalQty,
  }));

  // Выбранный товар: справочник есть всегда, FBS-строки может не быть
  const selected = productId ? (infoById.get(productId) ?? null) : null;
  const selectedFbs = selected
    ? (rows.find((r) => r.productId === selected.id) ?? null)
    : null;

  // Товар выбран на FBO, а на FBS его нет — всё равно кладём в селект,
  // иначе Base UI покажет в кнопке сырой uuid вместо названия
  if (selected && !selectedFbs) {
    filterProducts.push({
      id: selected.id,
      title: selected.title,
      category: selected.category,
      brand: selected.brand,
      stockQty: 0,
    });
  }

  const withStock = warehouses.filter((w) => w.qty > 0).length;
  const maxWh = warehouses[0]?.qty ?? 0;

  const kpis = [
    { label: "Всего на складах FBS", value: formatNumber(totalQty) + " шт" },
    { label: "Складов с остатком", value: `${withStock} из ${warehouses.length}` },
    { label: "Товаров с остатком", value: String(rows.length) },
    {
      label: "Срез данных",
      value: new Date(snapshotDate).toLocaleDateString("ru-RU"),
    },
  ];

  // Ссылка на товар с сохранением вкладки и фильтров
  const productHref = (id: string) => {
    const p = new URLSearchParams();
    p.set("tab", "fbs");
    if (category !== "all") p.set("category", category);
    if (brand !== "all") p.set("brand", brand);
    p.set("product", id);
    return `/stocks?${p.toString()}`;
  };

  // Матрица выбранного товара: размеры-колонки + продажи и runway по размерам
  const matrixSizes = selectedFbs?.sizes ?? [];
  const sizeSales = new Map(
    (selected?.sizes ?? []).map((s) => [s.size, s.sales30d]),
  );
  const sizeCover = (size: string, qty: number): number | null => {
    const cnt = sizeSales.get(size) ?? 0;
    return cnt > 0 ? Math.round(qty / (cnt / 30)) : null;
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
        productId={selected ? selected.id : null}
        tab="fbs"
      />

      {selected ? (
        // ── Выбранный товар: матрица личный склад × размер ──
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
                    {formatNumber(selectedFbs?.totalQty ?? 0)} шт на FBS
                  </Badge>
                  {(selectedFbs?.sales30d ?? 0) > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      продажи 30д: {formatNumber(selectedFbs?.sales30d ?? 0)} шт
                    </Badge>
                  )}
                  {selectedFbs?.daysOfCover != null && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        coverClass(selectedFbs.daysOfCover),
                      )}
                    >
                      хватит на ~{formatNumber(selectedFbs.daysOfCover)} дн
                    </Badge>
                  )}
                </span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0 pb-0">
            {!selectedFbs ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                На личных складах этого товара сейчас нет.
              </p>
            ) : (
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-normal">Склад</th>
                    {matrixSizes.map((s) => (
                      <th key={s.size} className="px-2 py-2 text-right font-normal">
                        {s.size}
                      </th>
                    ))}
                    <th className="px-4 py-2 text-right font-medium">Σ</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedFbs.warehouses.map((w) => (
                    <tr
                      key={w.warehouseId}
                      className="border-b border-border/40 last:border-0"
                    >
                      <td className="px-4 py-2">{w.name}</td>
                      {matrixSizes.map((s) => {
                        const v =
                          (w.sizes ?? []).find((x) => x.size === s.size)?.qty ?? 0;
                        return (
                          <td
                            key={s.size}
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
                        {formatNumber(w.qty)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-muted/20">
                    <td className="px-4 py-2 font-medium">Итого</td>
                    {matrixSizes.map((s) => (
                      <td
                        key={s.size}
                        className="px-2 py-2 text-right font-medium tabular-nums"
                      >
                        {formatNumber(s.qty)}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">
                      {formatNumber(selectedFbs.totalQty)}
                    </td>
                  </tr>
                  <tr className="text-xs text-muted-foreground">
                    <td className="px-4 py-2">Продажи/30д</td>
                    {matrixSizes.map((s) => {
                      const cnt = sizeSales.get(s.size) ?? 0;
                      return (
                        <td key={s.size} className="px-2 py-2 text-right tabular-nums">
                          {cnt > 0 ? formatNumber(cnt) : "—"}
                        </td>
                      );
                    })}
                    <td className="px-4 py-2 text-right tabular-nums">
                      {selectedFbs.sales30d > 0
                        ? formatNumber(selectedFbs.sales30d)
                        : "—"}
                    </td>
                  </tr>
                  <tr className="text-xs">
                    <td className="px-4 py-2 text-muted-foreground">Хватит на</td>
                    {matrixSizes.map((s) => {
                      const days = sizeCover(s.size, s.qty);
                      return (
                        <td
                          key={s.size}
                          className={cn(
                            "px-2 py-2 text-right tabular-nums",
                            coverClass(days),
                          )}
                        >
                          {days !== null ? `${formatNumber(days)} дн` : "—"}
                        </td>
                      );
                    })}
                    <td
                      className={cn(
                        "px-4 py-2 text-right font-medium tabular-nums",
                        coverClass(selectedFbs.daysOfCover),
                      )}
                    >
                      {selectedFbs.daysOfCover !== null
                        ? `${formatNumber(selectedFbs.daysOfCover)} дн`
                        : "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {!filtersActive && (
            // ── Обзор складов (фильтры не выбраны) ──
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Склады продавца</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {warehouses.map((w) => (
                  <div
                    key={w.warehouseId}
                    className={cn(
                      "flex items-center gap-3",
                      w.qty === 0 && "opacity-50",
                    )}
                  >
                    <span className="w-40 shrink-0 truncate text-sm" title={w.name}>
                      {w.name}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/40">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-400"
                        style={{
                          width: `${maxWh ? Math.max(w.qty ? 2 : 0, (w.qty / maxWh) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                      {formatNumber(w.qty)}
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {w.productsCount > 0 ? `${w.productsCount} тов.` : "пусто"}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* ── Список товаров (все или под фильтрами) ── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                {filtersActive ? (
                  <>
                    {category !== "all" ? category : "Все виды"}
                    {brand !== "all" && (
                      <Badge variant="secondary" className="text-[10px]">
                        {brand}
                      </Badge>
                    )}
                  </>
                ) : (
                  "Товары на складах FBS"
                )}
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {formatNumber(listed.length)} товаров ·{" "}
                  {formatNumber(listedQty)} шт
                </span>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                «хватит на» — по темпу продаж товара за 30 дней (все каналы)
              </p>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {listed.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {filtersActive
                    ? "Товаров под эти фильтры на FBS нет."
                    : "На личных складах сейчас пусто."}
                </p>
              )}
              {listed.map((p) => (
                <Link
                  key={p.productId}
                  href={productHref(p.productId)}
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
                    <span className="block truncate text-sm font-medium">
                      {p.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      арт. {p.nmId}
                      {p.priceDiscountedWb !== null &&
                        ` · ${formatSom(p.priceDiscountedWb)}`}
                    </span>
                    {p.sizes.length > 0 && (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {p.sizes
                          .map((s) => `${s.size} ${formatNumber(s.qty)}`)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-medium tabular-nums">
                      {formatNumber(p.totalQty)} шт
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
        </>
      )}
    </div>
  );
}
