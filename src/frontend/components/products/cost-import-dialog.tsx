"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { formatRub } from "@/shared/format";

type MatchedRow = {
  productId: string;
  nmId: number;
  title: string;
  oldCost: number;
  newCost: number;
};
type UnmatchedRow = { line: number; value: string; reason: string };
type Preview = { total: number; matched: MatchedRow[]; unmatched: UnmatchedRow[] };

// Импорт себестоимости из Excel/CSV: файл → превью (что применится) → запись.
// Колонки распознаются по заголовкам: «Артикул WB» / «Артикул продавца» +
// «Себестоимость». Товары матчатся по nm_id, затем по артикулу продавца.
export function CostImportDialog() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function send(mode: "preview" | "apply", f: File) {
    const form = new FormData();
    form.append("file", f);
    form.append("mode", mode);
    const res = await fetch("/api/products/cost-import", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.message ?? data?.error ?? "Ошибка импорта");
    }
    return data;
  }

  async function onFileChosen(f: File | null) {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setBusy(true);
    try {
      const data = await send("preview", f);
      setPreview({
        total: data.total ?? 0,
        matched: data.matched ?? [],
        unmatched: data.unmatched ?? [],
      });
    } catch (e) {
      toast.error((e as Error).message);
      reset();
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!file || !preview?.matched.length) return;
    setBusy(true);
    try {
      const data = await send("apply", file);
      toast.success(`Себестоимость обновлена у ${data.applied} товаров`);
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Upload className="size-3.5" />
        Импорт себестоимости
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) reset();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Импорт себестоимости</DialogTitle>
            <DialogDescription>
              Excel (.xlsx) или CSV с колонками «Артикул WB» (или «Артикул
              продавца») и «Себестоимость». Сначала покажем, что изменится.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border/80 px-4 py-6 text-sm text-muted-foreground transition hover:border-border hover:text-foreground"
            >
              <FileSpreadsheet className="size-4" />
              {file ? file.name : "Выбрать файл (.xlsx / .csv)"}
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xlsm,.csv,.txt"
                className="hidden"
                onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
            </label>

            {busy && !preview && (
              <div className="text-center text-sm text-muted-foreground">Читаю файл…</div>
            )}

            {preview && (
              <div className="space-y-2 text-sm">
                <div>
                  Найдено в файле: <b>{preview.total}</b> строк · применится к{" "}
                  <b className="text-emerald-400">{preview.matched.length}</b> товарам
                  {preview.unmatched.length > 0 && (
                    <>
                      {" "}· пропущено{" "}
                      <b className="text-amber-400">{preview.unmatched.length}</b>
                    </>
                  )}
                </div>

                {preview.matched.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-border/60">
                    <table className="w-full text-xs">
                      <tbody>
                        {preview.matched.slice(0, 50).map((m) => (
                          <tr key={m.productId} className="border-b border-border/40 last:border-0">
                            <td className="max-w-48 truncate px-2 py-1.5">{m.title}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                              {formatRub(m.oldCost)}
                            </td>
                            <td className="px-2 py-1.5 text-center text-muted-foreground">→</td>
                            <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                              {formatRub(m.newCost)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.matched.length > 50 && (
                      <div className="px-2 py-1.5 text-center text-[11px] text-muted-foreground">
                        …и ещё {preview.matched.length - 50}
                      </div>
                    )}
                  </div>
                )}

                {preview.unmatched.length > 0 && (
                  <div className="max-h-24 overflow-y-auto rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-400">
                    {preview.unmatched.slice(0, 20).map((u) => (
                      <div key={`${u.line}-${u.value}`}>
                        строка {u.line} ({u.value}): {u.reason}
                      </div>
                    ))}
                    {preview.unmatched.length > 20 && (
                      <div>…и ещё {preview.unmatched.length - 20}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Отмена
            </Button>
            <Button
              onClick={apply}
              disabled={busy || !preview || preview.matched.length === 0}
            >
              {busy && preview
                ? "Применяю…"
                : `Применить${preview ? ` (${preview.matched.length})` : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
