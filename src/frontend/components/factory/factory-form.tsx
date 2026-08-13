"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";
import { CURRENCY_CODES, CURRENCY_LABEL } from "@/shared/currency";
import type { Currency } from "@/shared/types";

export function FactoryForm({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [country, setCountry] = useState<"china" | "uzbekistan">("china");
  // Валюта расчётов: китайские фабрики выставляют счёт и в юанях, и в долларах —
  // от неё зависят отшив, карго и себестоимость партии.
  const [currency, setCurrency] = useState<Currency>("cny");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  function pickCountry(next: "china" | "uzbekistan") {
    setCountry(next);
    setCurrency(next === "uzbekistan" ? "uzs" : "cny");
  }

  async function submit() {
    if (!name.trim()) {
      toast.error("Укажите название фабрики");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/factory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          country,
          currency,
          note: note.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(
        data.persisted
          ? `Фабрика «${name.trim()}» добавлена`
          : `Фабрика «${name.trim()}» принята (демо — без записи в БД)`,
      );
      setName("");
      setNote("");
      setCountry("china");
      setCurrency("cny");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось добавить фабрику: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={disabled}>
        <Plus className="size-4" />
        Добавить фабрику
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новая фабрика</DialogTitle>
            <DialogDescription>
              Производитель товара. Валюта расчётов подставится в стоимость отшива и
              карго, а в отчётах сумма пересчитается в сомы по курсу из «Финансы →
              Валюты».
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="factory-name">Название</Label>
              <Input
                id="factory-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например, Guangzhou Textile Co."
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Страна</Label>
              <Select value={country} onValueChange={(v) => v && pickCountry(v as "china" | "uzbekistan")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="china">Китай</SelectItem>
                  <SelectItem value="uzbekistan">Узбекистан</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Валюта расчётов</Label>
              <Select value={currency} onValueChange={(v) => v && setCurrency(v as Currency)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_CODES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CURRENCY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="factory-note">Заметка (необязательно)</Label>
              <Input
                id="factory-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Что отшивает, контакт и т. п."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Сохранение…" : "Добавить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
