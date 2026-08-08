"use client";

import { useEffect, useMemo, useState } from "react";
import { ImageOff, LayoutGrid, List, SearchX } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import {
  ProductCell,
  ProductDialog,
} from "@/frontend/components/products/product-card-dialog";
import { CostImportDialog } from "@/frontend/components/products/cost-import-dialog";
import {
  applyFilters,
  EMPTY_FILTERS,
  ProductsFilters,
  type ProductFilters,
} from "@/frontend/components/products/products-filters";
import { ProductForm } from "@/frontend/components/products/product-form";
import {
  GroupSelect,
  GroupsManageDialog,
} from "@/frontend/components/products/product-groups";
import {
  catalogContext,
  RecoButton,
} from "@/frontend/components/products/reco-button";
import { formatNumber, formatRub } from "@/shared/format";
import type { ProductGroup, ProductListItem } from "@/shared/types";

type ViewMode = "cards" | "table";
const VIEW_KEY = "wbcrm-products-view";

// Цвет запаса «на сколько хватит»: <14 дн — критично, <30 — предупреждение,
// >120 — затоваривание.
function coverClass(days: number | null): string {
  if (days === null) return "text-muted-foreground";
  if (days < 14) return "text-red-400";
  if (days < 30) return "text-amber-400";
  if (days > 120) return "text-amber-400";
  return "text-emerald-400";
}

// ─── Карточка в сетке ────────────────────────────────────────────────────────

function GridCard({
  product,
  canEdit,
  catalog,
  groups,
  canGroups,
}: {
  product: ProductListItem;
  canEdit: boolean;
  catalog?: ReturnType<typeof catalogContext>;
  groups: ProductGroup[];
  canGroups: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Enter" && setOpen(true)}
        className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition hover:border-border hover:shadow-lg"
      >
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-muted/40">
          {product.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.photoUrl}
              alt={product.title}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <ImageOff className="size-8" />
            </div>
          )}
          {product.isWeak && (
            <Badge
              variant="outline"
              className="absolute left-2 top-2 border-red-500/60 bg-background/80 text-[10px] text-red-400 backdrop-blur"
            >
              слабый
            </Badge>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-1 p-3">
          <div className="truncate text-[11px] text-muted-foreground">
            {product.category !== "—" ? product.category : ""}
            {product.category !== "—" && " · "}
            {product.nmId}
          </div>
          <div className="line-clamp-2 text-sm font-medium leading-snug">
            {product.title}
          </div>
          {product.description && (
            <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
              {product.description}
            </p>
          )}
          <div className="mt-auto flex items-baseline gap-1.5 pt-1.5">
            {product.priceDiscountedWb !== null ? (
              <>
                <span className="text-base font-semibold tabular-nums">
                  {formatRub(product.priceDiscountedWb)}
                </span>
                {product.priceWb !== null &&
                  product.priceWb > product.priceDiscountedWb && (
                    <span className="text-xs text-muted-foreground line-through tabular-nums">
                      {formatRub(product.priceWb)}
                    </span>
                  )}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">без цены</span>
            )}
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {formatNumber(product.stockQty)} шт
            </span>
          </div>

          {(product.isWeak || canEdit) && (
            <div
              className="flex items-center justify-end gap-1 pt-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {product.isWeak && <RecoButton product={product} catalog={catalog} />}
              {canEdit && <ProductForm product={product} />}
            </div>
          )}
        </div>
      </div>
      <ProductDialog
        product={product}
        open={open}
        onOpenChange={setOpen}
        catalog={catalog}
        groups={groups}
        canGroups={canGroups}
      />
    </>
  );
}

// ─── Таблица (прежний список) ────────────────────────────────────────────────

function ProductsTable({
  products,
  canEdit,
  catalog,
  groups,
  canGroups,
}: {
  products: ProductListItem[];
  canEdit: boolean;
  catalog?: ReturnType<typeof catalogContext>;
  groups: ProductGroup[];
  canGroups: boolean;
}) {
  // Колонка «Группа» появляется, когда группы заведены: право назначать даёт
  // селект, остальным — просто название группы товара
  const showGroups = groups.length > 0 || products.some((p) => p.groupId !== null);
  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Товар</TableHead>
              <TableHead>Категория</TableHead>
              <TableHead>Статус</TableHead>
              {showGroups && <TableHead>Группа</TableHead>}
              <TableHead className="text-right">Цена WB</TableHead>
              <TableHead className="text-right">Себест.</TableHead>
              <TableHead className="text-right">Маржа</TableHead>
              <TableHead className="text-right">Остаток, шт</TableHead>
              <TableHead className="text-right">В пути в МСК</TableHead>
              <TableHead className="text-right">Продаж/30д</TableHead>
              <TableHead className="text-right">Хватит на</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ProductCell
                      product={p}
                      catalog={catalog}
                      groups={groups}
                      canGroups={canGroups}
                    />
                    {p.isWeak && (
                      <Badge
                        variant="outline"
                        className="border-red-500/50 text-[10px] text-red-400"
                      >
                        слабый
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{p.category}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-[10px]">
                    {p.status}
                  </Badge>
                </TableCell>
                {showGroups && (
                  <TableCell>
                    {canGroups ? (
                      <GroupSelect
                        productId={p.id}
                        value={p.groupId}
                        groups={groups}
                        className="h-7 w-36 text-xs"
                      />
                    ) : (
                      <span className="text-muted-foreground">
                        {p.groupName ?? "—"}
                      </span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-right tabular-nums">
                  {p.priceDiscountedWb !== null ? formatRub(p.priceDiscountedWb) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatRub(p.costPrice)}
                  {p.costPrice > 0 && p.costPriceSource !== "manual" && (
                    <span className="block text-[10px] text-muted-foreground">
                      {p.costPriceSource === "supply" ? "из поставки" : "импорт"}
                    </span>
                  )}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${
                    p.econ
                      ? p.econ.marginPct > 0
                        ? "text-emerald-400"
                        : "text-red-400"
                      : "text-muted-foreground"
                  }`}
                  title={
                    p.econ
                      ? `Прибыль ${formatRub(p.econ.profitPerUnitRub)}/шт за 30 дней`
                      : "Продаж за 30 дней не было"
                  }
                >
                  {p.econ ? `${p.econ.marginPct}%` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(p.stockQty)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {p.inTransitToMoscow > 0 ? formatNumber(p.inTransitToMoscow) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(p.salesRank30d)}
                  <span className="ml-1 text-muted-foreground">
                    ({p.avgDailySales}/дн)
                  </span>
                </TableCell>
                <TableCell className={`text-right tabular-nums ${coverClass(p.daysOfCover)}`}>
                  {p.daysOfCover !== null ? `${p.daysOfCover} дн` : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {p.isWeak && <RecoButton product={p} catalog={catalog} />}
                    {canEdit && <ProductForm product={p} />}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Корневой компонент: переключатель Карточки / Список ────────────────────

export function ProductsView({
  products,
  groups,
  canEdit,
  canGroups,
}: {
  products: ProductListItem[];
  groups: ProductGroup[];
  canEdit: boolean;
  canGroups: boolean;
}) {
  const [view, setView] = useState<ViewMode>("cards");
  const [filters, setFilters] = useState<ProductFilters>(EMPTY_FILTERS);

  // Отбор идёт на клиенте: список товаров уже целиком пришёл с сервера, поэтому
  // поиск и фильтры срабатывают мгновенно, без похода за данными.
  const visible = useMemo(() => applyFilters(products, filters), [products, filters]);

  // Медианы каталога считаем один раз и отдаём в разбор ИИ — чтобы он сравнивал
  // товар с остальными товарами ЭТОГО продавца, а не с выдуманным рынком.
  const catalog = useMemo(() => catalogContext(products), [products]);

  // Выбор вида сохраняется между визитами (localStorage, после маунта —
  // чтобы SSR-разметка не расходилась с клиентом)
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === "table" || saved === "cards") setView(saved);
  }, []);

  function switchView(v: ViewMode) {
    setView(v);
    window.localStorage.setItem(VIEW_KEY, v);
  }

  if (products.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Товаров пока нет.
          {canEdit
            ? " Запустите синхронизацию WB на «Интеграциях» или добавьте карточку вручную."
            : " Карточки появятся после синхронизации с WB."}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <ProductsFilters
        products={products}
        groups={groups}
        shown={visible.length}
        filters={filters}
        onChange={setFilters}
        right={
          <>
            {canGroups && (
              <GroupsManageDialog groups={groups} products={products} />
            )}
            {canEdit && <CostImportDialog />}
            <div className="flex gap-1 rounded-lg border border-border/60 p-0.5">
              <Button
                size="xs"
                variant={view === "cards" ? "secondary" : "ghost"}
                onClick={() => switchView("cards")}
                aria-label="Карточки"
              >
                <LayoutGrid className="size-3.5" />
                Карточки
              </Button>
              <Button
                size="xs"
                variant={view === "table" ? "secondary" : "ghost"}
                onClick={() => switchView("table")}
                aria-label="Список"
              >
                <List className="size-3.5" />
                Список
              </Button>
            </div>
          </>
        }
      />

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <SearchX className="size-6" />
            Под фильтры не подошёл ни один товар.
            <Button size="sm" variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
              Сбросить фильтры
            </Button>
          </CardContent>
        </Card>
      ) : view === "cards" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {visible.map((p) => (
            <GridCard
              key={p.id}
              product={p}
              canEdit={canEdit}
              catalog={catalog}
              groups={groups}
              canGroups={canGroups}
            />
          ))}
        </div>
      ) : (
        <ProductsTable
          products={visible}
          canEdit={canEdit}
          catalog={catalog}
          groups={groups}
          canGroups={canGroups}
        />
      )}
    </div>
  );
}
