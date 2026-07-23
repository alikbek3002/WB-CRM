"use client";

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { formatNumber, formatRub } from "@/shared/format";
import type { ProductListItem } from "@/shared/types";

// Карточка-диалог товара: большое фото, галерея, описание, цены WB.
// Открывается из таблицы (ProductCell) и из сетки карточек (products-view).
export function ProductDialog({
  product,
  open,
  onOpenChange,
}: {
  product: ProductListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [photo, setPhoto] = useState(0);
  const gallery = product.photos.length
    ? product.photos
    : product.photoUrl
      ? [product.photoUrl]
      : [];

  // при повторном открытии начинаем с первого фото
  useEffect(() => {
    if (open) setPhoto(0);
  }, [open]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="pr-6">{product.title}</DialogTitle>
            <DialogDescription>
              Артикул WB {product.nmId}
              {product.vendorCode ? ` · ${product.vendorCode}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[240px_1fr]">
            {/* Фото + галерея */}
            <div className="space-y-2">
              {gallery.length > 0 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={gallery[photo]}
                  alt={product.title}
                  className="aspect-[3/4] w-full rounded-lg border border-border/60 object-cover"
                />
              ) : (
                <div className="flex aspect-[3/4] w-full items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                  <ImageOff className="size-8" />
                </div>
              )}
              {gallery.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto">
                  {gallery.slice(0, 6).map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={url}
                      src={url}
                      alt=""
                      onClick={() => setPhoto(i)}
                      className={`h-14 w-10 shrink-0 cursor-pointer rounded-md border object-cover ${
                        i === photo ? "border-primary" : "border-border/60 opacity-70"
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Инфо */}
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {product.brand !== "—" && product.brand && (
                  <Badge variant="secondary" className="text-[10px]">
                    {product.brand}
                  </Badge>
                )}
                {product.category !== "—" && product.category && (
                  <Badge variant="outline" className="text-[10px]">
                    {product.category}
                  </Badge>
                )}
                <Badge variant="secondary" className="text-[10px]">
                  {product.status}
                </Badge>
                {product.isWeak && (
                  <Badge
                    variant="outline"
                    className="border-red-500/50 text-[10px] text-red-400"
                  >
                    слабый
                  </Badge>
                )}
              </div>

              {product.priceDiscountedWb !== null && (
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatRub(product.priceDiscountedWb)}
                  </span>
                  {product.priceWb !== null &&
                    product.priceWb > product.priceDiscountedWb && (
                      <span className="text-sm text-muted-foreground line-through tabular-nums">
                        {formatRub(product.priceWb)}
                      </span>
                    )}
                  <span className="text-xs text-muted-foreground">цена WB</span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <span className="text-muted-foreground">Остаток</span>
                <span className="text-right tabular-nums">
                  {formatNumber(product.stockQty)} шт
                </span>
                <span className="text-muted-foreground">В пути в МСК</span>
                <span className="text-right tabular-nums">
                  {product.inTransitToMoscow > 0
                    ? `${formatNumber(product.inTransitToMoscow)} шт`
                    : "—"}
                </span>
                <span className="text-muted-foreground">Продаж за 30 дней</span>
                <span className="text-right tabular-nums">
                  {formatNumber(product.salesRank30d)} ({product.avgDailySales}/дн)
                </span>
                <span className="text-muted-foreground">Хватит на</span>
                <span className="text-right tabular-nums">
                  {product.daysOfCover !== null ? `${product.daysOfCover} дн` : "—"}
                </span>
                <span className="text-muted-foreground">Себестоимость</span>
                <span className="text-right tabular-nums">
                  {formatRub(product.costPrice)}
                </span>
                <span className="text-muted-foreground">Ответственный</span>
                <span className="truncate text-right">{product.responsible}</span>
              </div>

              {product.description && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Описание
                  </div>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {product.description}
                  </p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Ячейка товара в таблице: миниатюра + название, клик открывает карточку.
export function ProductCell({ product }: { product: ProductListItem }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 text-left hover:opacity-80"
      >
        {product.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.photoUrl}
            alt=""
            loading="lazy"
            className="h-12 w-9 shrink-0 rounded-md border border-border/60 object-cover"
          />
        ) : (
          <span className="flex h-12 w-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
            <ImageOff className="size-4" />
          </span>
        )}
        <span>
          <span className="block font-medium leading-tight">{product.title}</span>
          <span className="block text-xs text-muted-foreground">
            {product.vendorCode || "—"}
          </span>
        </span>
      </button>
      <ProductDialog product={product} open={open} onOpenChange={setOpen} />
    </>
  );
}
