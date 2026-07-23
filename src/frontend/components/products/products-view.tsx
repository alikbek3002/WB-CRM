"use client";

import { useEffect, useState } from "react";
import { ImageOff, LayoutGrid, List } from "lucide-react";
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
import { ProductForm } from "@/frontend/components/products/product-form";
import { RecoButton } from "@/frontend/components/products/reco-button";
import { formatNumber, formatRub } from "@/shared/format";
import type { ProductListItem } from "@/shared/types";

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
}: {
  product: ProductListItem;
  canEdit: boolean;
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
              {product.isWeak && <RecoButton product={product} />}
              {canEdit && <ProductForm product={product} />}
            </div>
          )}
        </div>
      </div>
      <ProductDialog product={product} open={open} onOpenChange={setOpen} />
    </>
  );
}

// ─── Таблица (прежний список) ────────────────────────────────────────────────

function ProductsTable({
  products,
  canEdit,
}: {
  products: ProductListItem[];
  canEdit: boolean;
}) {
  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Товар</TableHead>
              <TableHead>Категория</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Цена WB</TableHead>
              <TableHead className="text-right">Себест.</TableHead>
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
                    <ProductCell product={p} />
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
                <TableCell className="text-right tabular-nums">
                  {p.priceDiscountedWb !== null ? formatRub(p.priceDiscountedWb) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatRub(p.costPrice)}
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
                    {p.isWeak && <RecoButton product={p} />}
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
  canEdit,
}: {
  products: ProductListItem[];
  canEdit: boolean;
}) {
  const [view, setView] = useState<ViewMode>("cards");

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
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {formatNumber(products.length)} товаров
        </div>
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
      </div>

      {view === "cards" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {products.map((p) => (
            <GridCard key={p.id} product={p} canEdit={canEdit} />
          ))}
        </div>
      ) : (
        <ProductsTable products={products} canEdit={canEdit} />
      )}
    </div>
  );
}
