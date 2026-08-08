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
import { GroupSelect } from "@/frontend/components/products/product-groups";
import {
  catalogContext,
  RecoButton,
} from "@/frontend/components/products/reco-button";
import { formatNumber, formatRub } from "@/shared/format";
import type {
  CostPriceSource,
  ProductGroup,
  ProductListItem,
  ProductSizeStock,
} from "@/shared/types";

const COST_SOURCE_LABEL: Record<CostPriceSource, string> = {
  manual: "вручную",
  import: "импорт из файла",
  supply: "из поставки",
};

// Остатки по размерам — прямо в карточке, без раскрытия и догрузки.
// Под остатком — «на сколько хватит» размера при темпе продаж за 30 дней.
// Цвет подсказывает, где дырка в размерном ряду: красный — размера нет
// (а если он при этом продавался — вымыт, сигнал к дозаказу), амбер — запаса
// меньше двух недель. Пока данных о продажах по размерам нет (товар без
// продаж), «мало» считается старой эвристикой: меньше 5% общего остатка.
function SizeStocks({ sizes }: { sizes: ProductSizeStock[] }) {
  if (sizes.length === 0) return null;

  const total = sizes.reduce((t, s) => t + s.onStock, 0);
  const transit = sizes.reduce((t, s) => t + s.inTransit, 0);
  const out = sizes.filter((s) => s.onStock === 0).length;
  const hasVelocity = sizes.some((s) => s.sales30d > 0);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Остатки по размерам · {sizes.length}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {out > 0 ? `нет в наличии: ${out}` : "весь ряд в наличии"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {sizes.map((s) => {
          const empty = s.onStock === 0;
          const low = hasVelocity
            ? !empty && s.daysOfCover !== null && s.daysOfCover <= 14
            : !empty && total > 0 && s.onStock / total < 0.05;
          const rate = Math.round((s.sales30d / 30) * 10) / 10;
          const hint = [
            `${s.size}: ${formatNumber(s.onStock)} шт на складах`,
            ...(s.inTransit > 0 ? [`${formatNumber(s.inTransit)} шт в пути`] : []),
            s.sales30d > 0
              ? `продажи за 30 дн: ${formatNumber(s.sales30d)} шт (${rate}/дн)`
              : "продаж за 30 дн нет",
            ...(s.daysOfCover !== null
              ? [
                  empty
                    ? "вымыт — дозаказать"
                    : `хватит на ~${formatNumber(s.daysOfCover)} дн`,
                ]
              : []),
          ].join(" · ");
          return (
            <div
              key={s.size}
              title={hint}
              className={`min-w-14 rounded-md border px-2 py-1 text-center ${
                empty
                  ? "border-red-500/40 bg-red-500/5"
                  : low
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-border/60 bg-background/40"
              }`}
            >
              <div className="truncate text-[10px] leading-tight text-muted-foreground">
                {s.size}
              </div>
              <div
                className={`text-sm font-medium leading-tight tabular-nums ${
                  empty ? "text-red-400" : low ? "text-amber-400" : ""
                }`}
              >
                {formatNumber(s.onStock)}
              </div>
              {s.daysOfCover !== null && (
                <div
                  className={`text-[10px] leading-tight tabular-nums ${
                    empty
                      ? "text-red-400"
                      : low
                        ? "text-amber-400"
                        : "text-muted-foreground"
                  }`}
                >
                  {s.daysOfCover > 999 ? "999+" : s.daysOfCover} дн
                </div>
              )}
              {s.inTransit > 0 && (
                <div className="text-[10px] leading-tight text-muted-foreground">
                  +{formatNumber(s.inTransit)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(hasVelocity || transit > 0) && (
        <div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {hasVelocity && (
            <div>
              «N дн» — на сколько хватит размера при темпе продаж за 30 дней;
              «0 дн» у пустого — размер продавался и вымыт
            </div>
          )}
          {transit > 0 && (
            <div>
              Серым «+N» — в пути между складами WB, всего {formatNumber(transit)} шт
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Из чего сложилась себестоимость. Показываем только когда она пришла из
// приёмки поставки — при ручном вводе и импорте разбивки нет, там просто число.
function CostBreakdown({ product }: { product: ProductListItem }) {
  const parts = [
    { label: "отшив", value: product.costSewingRub },
    { label: "карго", value: product.costCargoRub },
    { label: "фул-фирма", value: product.costFulfillmentRub },
  ].filter((p) => p.value > 0);

  if (product.costPriceSource !== "supply" || parts.length < 2) return null;

  return (
    <span className="mt-0.5 block text-[10px] font-normal leading-tight text-muted-foreground">
      {parts.map((p) => `${p.label} ${formatRub(p.value)}`).join(" + ")}
    </span>
  );
}

function costSourceLabel(product: ProductListItem): string | null {
  if (product.costPrice <= 0) return null;
  const label = COST_SOURCE_LABEL[product.costPriceSource] ?? null;
  if (!label) return null;
  const date = product.costPriceUpdatedAt
    ? new Date(product.costPriceUpdatedAt).toLocaleDateString("ru-RU")
    : null;
  return date ? `${label} · ${date}` : label;
}

// Карточка-диалог товара: большое фото, галерея, описание, цены WB.
// Открывается из таблицы (ProductCell) и из сетки карточек (products-view).
export function ProductDialog({
  product,
  open,
  onOpenChange,
  catalog,
  groups = [],
  canGroups = false,
}: {
  product: ProductListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog?: ReturnType<typeof catalogContext>;
  groups?: ProductGroup[];
  canGroups?: boolean;
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

          {/* Разбор ИИ доступен для ЛЮБОГО товара, а не только помеченного
              слабым: понять, почему хороший товар хороший, не менее полезно. */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              Почему товар продаётся так, и что улучшить — фото, цену, описание,
              размеры
            </span>
            <RecoButton
              product={product}
              catalog={catalog}
              size="sm"
              variant="secondary"
              label="Разобрать через ИИ"
              className="ml-auto"
            />
          </div>

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
                  {costSourceLabel(product) && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      {costSourceLabel(product)}
                    </span>
                  )}
                  <CostBreakdown product={product} />
                </span>
                <span className="text-muted-foreground">Ответственный</span>
                <span className="truncate text-right">{product.responsible}</span>
                {/* Группа: директор/ст. менеджер назначают прямо из карточки,
                    остальные видят название */}
                {(canGroups && groups.length > 0) || product.groupName ? (
                  <>
                    <span className="self-center text-muted-foreground">Группа</span>
                    {canGroups && groups.length > 0 ? (
                      <GroupSelect
                        productId={product.id}
                        value={product.groupId}
                        groups={groups}
                        className="h-8 w-44 justify-self-end text-xs"
                      />
                    ) : (
                      <span className="truncate text-right">{product.groupName}</span>
                    )}
                  </>
                ) : null}
              </div>

              <SizeStocks sizes={product.sizes} />

              {product.econ && (
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Юнит-экономика · {product.econ.periodDays} дней · на единицу
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      продано {formatNumber(product.econ.saleQty)} шт
                    </span>
                  </div>
                  <div className="space-y-1 text-sm">
                    {[
                      { label: "Цена реализации", value: product.econ.priceRub, plus: true },
                      { label: "Комиссия и эквайринг", value: -product.econ.commissionRub },
                      { label: "Логистика", value: -product.econ.logisticsRub },
                      { label: "Хранение", value: -product.econ.storageRub },
                      { label: "Приёмка", value: -product.econ.acceptanceRub },
                      {
                        label: `Реклама (ДРР ${product.econ.drrPct}%)`,
                        value: -product.econ.advertRub,
                      },
                      { label: "Себестоимость", value: -product.econ.costPrice },
                    ]
                      .filter((r) => r.value !== 0 || r.plus)
                      .map((r) => (
                        <div key={r.label} className="flex justify-between">
                          <span className="text-muted-foreground">{r.label}</span>
                          <span className="tabular-nums">
                            {r.value > 0 ? "" : "−"}
                            {formatRub(Math.abs(r.value))}
                          </span>
                        </div>
                      ))}
                    <div className="flex justify-between border-t border-border/60 pt-1 font-medium">
                      <span>Прибыль с единицы</span>
                      <span
                        className={`tabular-nums ${
                          product.econ.profitPerUnitRub > 0
                            ? "text-emerald-400"
                            : product.econ.profitPerUnitRub < 0
                              ? "text-red-400"
                              : ""
                        }`}
                      >
                        {formatRub(product.econ.profitPerUnitRub)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        маржа {product.econ.marginPct}%
                        {product.econ.costPrice > 0 && ` · ROI ${product.econ.roiPct}%`}
                      </span>
                      <span className="tabular-nums">
                        за период: {formatRub(product.econ.profitRub)}
                      </span>
                    </div>
                    {product.econ.costPrice <= 0 && (
                      <div className="text-[11px] text-amber-400">
                        Себестоимость не заполнена — прибыль завышена
                      </div>
                    )}
                  </div>
                </div>
              )}

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
export function ProductCell({
  product,
  catalog,
  groups,
  canGroups,
}: {
  product: ProductListItem;
  catalog?: ReturnType<typeof catalogContext>;
  groups?: ProductGroup[];
  canGroups?: boolean;
}) {
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
