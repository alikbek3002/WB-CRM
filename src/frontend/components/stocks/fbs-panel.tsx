import { ImageOff } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { formatNumber } from "@/shared/format";
import { cn } from "@/shared/utils";
import type { FbsStocksView } from "@/shared/types";

// Вкладка FBS — остатки на личных складах продавца (marketplace-api).
// Показываем последний срез: обзор складов + товары с разбивкой по складам
// и размерам. Обновляется live-синком каждые ~30 минут.
export function FbsPanel({ view }: { view: FbsStocksView }) {
  const { warehouses, products, totalQty, snapshotDate } = view;

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

  const maxWh = warehouses[0]?.qty ?? 0;
  const withStock = warehouses.filter((w) => w.qty > 0).length;

  const kpis = [
    { label: "Всего на складах FBS", value: formatNumber(totalQty) + " шт" },
    { label: "Складов продавца", value: String(warehouses.length) },
    { label: "Складов с остатком", value: String(withStock) },
    {
      label: "Срез данных",
      value: new Date(snapshotDate).toLocaleDateString("ru-RU"),
    },
  ];

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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Склады продавца</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {warehouses.map((w) => (
            <div
              key={w.warehouseId}
              className={cn("flex items-center gap-3", w.qty === 0 && "opacity-50")}
            >
              <span className="w-40 shrink-0 truncate text-sm" title={w.name}>
                {w.name}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/40">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-400"
                  style={{ width: `${maxWh ? Math.max(w.qty ? 2 : 0, (w.qty / maxWh) * 100) : 0}%` }}
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Товары на складах FBS
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {formatNumber(products.length)} товаров · {formatNumber(totalQty)} шт
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {products.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              На личных складах сейчас пусто.
            </p>
          )}
          {products.map((p) => (
            <div
              key={p.productId}
              className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
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
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">арт. {p.nmId}</span>
                  {p.warehouses.map((w) => (
                    <Badge
                      key={w.warehouseId}
                      variant="outline"
                      className="text-[10px]"
                      title={w.name}
                    >
                      {w.name} · {formatNumber(w.qty)}
                    </Badge>
                  ))}
                </span>
                {p.sizes.length > 0 && (
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {p.sizes
                      .map((s) => `${s.size || "б/р"} ${formatNumber(s.qty)}`)
                      .join(" · ")}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right text-sm font-medium tabular-nums">
                {formatNumber(p.totalQty)} шт
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
