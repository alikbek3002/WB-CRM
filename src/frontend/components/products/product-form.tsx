"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Input } from "@/frontend/components/ui/input";
import { Label } from "@/frontend/components/ui/label";
import type { ProductListItem } from "@/shared/types";

// Одна форма на два режима: без product — «Добавить товар», с product — карандаш
// редактирования (артикул WB после создания не меняется).
export function ProductForm({ product }: { product?: ProductListItem }) {
  const router = useRouter();
  const isEdit = Boolean(product);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [nmId, setNmId] = useState(product ? String(product.nmId) : "");
  const [title, setTitle] = useState(product?.title ?? "");
  const [vendorCode, setVendorCode] = useState(product?.vendorCode ?? "");
  const [brand, setBrand] = useState(product?.brand ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [status, setStatus] = useState(product?.status ?? "");
  const [costPrice, setCostPrice] = useState(
    product ? String(product.costPrice) : "",
  );
  const [logisticsCost, setLogisticsCost] = useState(
    product ? String(product.logisticsCost) : "",
  );

  // При каждом открытии пересеваем поля из актуального пропа: иначе отменённые
  // правки «воскресают», а изменения с сервера (router.refresh) не видны.
  function openDialog() {
    if (product) {
      setNmId(String(product.nmId));
      setTitle(product.title);
      setVendorCode(product.vendorCode ?? "");
      setBrand(product.brand === "—" ? "" : product.brand);
      setCategory(product.category === "—" ? "" : product.category);
      setStatus(product.status === "—" ? "" : product.status);
      setCostPrice(String(product.costPrice));
      setLogisticsCost(String(product.logisticsCost));
    }
    setOpen(true);
  }

  // «12,5» → 12.5; пустая строка → 0
  function parseMoney(raw: string): number {
    if (raw.trim() === "") return 0;
    return Number(raw.replace(",", ".").trim());
  }

  async function submit() {
    const nm = Number(nmId);
    if (!isEdit && (!Number.isInteger(nm) || nm <= 0)) {
      toast.error("Укажите артикул WB (число)");
      return;
    }
    if (!title.trim()) {
      toast.error("Укажите название товара");
      return;
    }
    const cost = parseMoney(costPrice);
    const logistics = parseMoney(logisticsCost);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(logistics) || logistics < 0) {
      toast.error("Себестоимость и логистика — неотрицательные числа");
      return;
    }
    setSaving(true);
    try {
      const common = {
        title: title.trim(),
        vendorCode: vendorCode.trim() || null,
        brand: brand.trim() || null,
        category: category.trim() || null,
        status: status.trim() || null,
        costPrice: cost,
        logisticsCost: logistics,
      };
      const res = await fetch("/api/products", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          isEdit ? { id: product!.id, ...common } : { nmId: nm, ...common },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.error === "duplicate_nm_id") {
          throw new Error("Товар с таким артикулом WB уже есть");
        }
        throw new Error(data?.error ?? "Ошибка");
      }
      toast.success(
        data.persisted
          ? isEdit
            ? `Товар «${title.trim()}» обновлён`
            : `Товар «${title.trim()}» добавлен`
          : `Принято (демо — без записи в БД)`,
      );
      setOpen(false);
      if (!isEdit) {
        setNmId("");
        setTitle("");
        setVendorCode("");
        setBrand("");
        setCategory("");
        setStatus("");
        setCostPrice("");
        setLogisticsCost("");
      }
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось сохранить товар: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {isEdit ? (
        <Button size="xs" variant="ghost" onClick={openDialog} aria-label="Редактировать">
          <Pencil className="size-3.5" />
        </Button>
      ) : (
        <Button size="sm" onClick={openDialog}>
          <Plus className="size-4" />
          Добавить товар
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Товар · ${product!.title}` : "Новый товар"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Редактирование карточки. Артикул WB не меняется."
                : "Карточка товара WB. После подключения WB API карточки будут подтягиваться автоматически."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0">
            <div className="grid gap-1.5">
              <Label htmlFor="prod-nm">Артикул WB (nm_id)</Label>
              <Input
                id="prod-nm"
                inputMode="numeric"
                value={nmId}
                onChange={(e) => setNmId(e.target.value)}
                placeholder="173562489"
                disabled={isEdit}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prod-vendor">Артикул продавца</Label>
              <Input
                id="prod-vendor"
                value={vendorCode}
                onChange={(e) => setVendorCode(e.target.value)}
                placeholder="ART-0001"
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="prod-title">Название</Label>
              <Input
                id="prod-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Кимоно шёлковое, айвори"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prod-brand">Бренд</Label>
              <Input
                id="prod-brand"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Kimono Brand"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prod-category">Категория</Label>
              <Input
                id="prod-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Костюмы"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prod-status">Статус</Label>
              <Input
                id="prod-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                placeholder="Новинка / Локомотив…"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prod-cost">Себестоимость, ₽</Label>
              <Input
                id="prod-cost"
                inputMode="decimal"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prod-logistics">Логистика, ₽/шт</Label>
              <Input
                id="prod-logistics"
                inputMode="decimal"
                value={logisticsCost}
                onChange={(e) => setLogisticsCost(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Сохранение…" : isEdit ? "Сохранить" : "Добавить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
