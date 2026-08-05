import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { DEMO_STORE_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData, PRODUCT_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Массовый импорт себестоимости из Excel/CSV. Формат свободный: ищем колонки
// по заголовкам (артикул WB / артикул продавца / себестоимость), матчим товары
// по nm_id, затем по vendor_code. mode=preview ничего не пишет — UI показывает,
// что применится; mode=apply обновляет cost_price + пишет product_cost_history.

type ParsedRow = {
  line: number;
  nmId: number | null;
  vendorCode: string | null;
  costPrice: number | null;
};

type MatchedRow = {
  productId: string;
  nmId: number;
  title: string;
  oldCost: number;
  newCost: number;
};

type UnmatchedRow = { line: number; value: string; reason: string };

function normalizeHeader(v: string): string {
  return v.toLowerCase().replace(/[\s_\-–—.,:;()₽]+/g, " ").trim();
}

const NM_HEADERS = ["nm id", "nmid", "артикул wb", "артикул вб", "артикул wildberries", "номенклатура", "код wb"];
const VENDOR_HEADERS = ["vendor code", "vendorcode", "артикул продавца", "артикул поставщика", "артикул"];
const COST_HEADERS = ["cost price", "costprice", "себестоимость", "себес", "закупочная цена", "цена закупки", "закупка"];

function findColumn(headers: string[], candidates: string[]): number {
  // сперва точное совпадение, потом вхождение («себестоимость руб» и т.п.)
  for (const c of candidates) {
    const exact = headers.findIndex((h) => h === c);
    if (exact >= 0) return exact;
  }
  for (const c of candidates) {
    const partial = headers.findIndex((h) => h.includes(c));
    if (partial >= 0) return partial;
  }
  return -1;
}

// «1 250,50 ₽» → 1250.5; мусор → null
function parseMoney(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw)
    .replace(/[₽рруб.]+\s*$/i, "")
    .replace(/[\s  ]/g, "")
    .replace(",", ".")
    .trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseNmId(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[\s ]/g, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Таблица (строки × ячейки) → распознавание колонок по первой строке + данные
function tableToRows(table: unknown[][]): { rows: ParsedRow[]; errors: string[] } {
  if (!table.length) return { rows: [], errors: ["Файл пустой"] };
  const headers = table[0].map((h) => normalizeHeader(String(h ?? "")));
  const nmCol = findColumn(headers, NM_HEADERS);
  const vendorCol = findColumn(headers, VENDOR_HEADERS);
  const costCol = findColumn(headers, COST_HEADERS);

  if (costCol < 0 || (nmCol < 0 && vendorCol < 0)) {
    return {
      rows: [],
      errors: [
        "Не распознаны колонки. Нужны заголовки: «Артикул WB» (или «Артикул продавца») и «Себестоимость».",
      ],
    };
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i] ?? [];
    const isEmpty = cells.every((c) => c == null || String(c).trim() === "");
    if (isEmpty) continue;
    rows.push({
      line: i + 1,
      nmId: nmCol >= 0 ? parseNmId(cells[nmCol]) : null,
      vendorCode:
        vendorCol >= 0 && cells[vendorCol] != null && String(cells[vendorCol]).trim() !== ""
          ? String(cells[vendorCol]).trim()
          : null,
      costPrice: parseMoney(cells[costCol]),
    });
  }
  return { rows, errors: [] };
}

// В ячейках exceljs бывают объекты (формулы, rich text) — приводим к примитиву
function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null || typeof v !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if ("result" in v) return v.result; // формула
  if ("richText" in v) return v.richText.map((r) => r.text).join("");
  if ("text" in v) return v.text; // гиперссылка
  return String(v);
}

async function parseXlsx(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const table: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    // values — 1-индексированный массив; выравниваем в 0-индексацию
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellValue(row.getCell(c).value));
    table.push(cells);
  });
  return table;
}

function parseCsv(buf: Buffer): unknown[][] {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  // Excel в русской локали часто сохраняет CSV в windows-1251 — ловим кракозябры
  if (text.includes("�")) {
    text = new TextDecoder("windows-1251").decode(buf);
  }
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
    skipEmptyLines: true,
    delimitersToGuess: [",", ";", "\t"],
  });
  return res.data;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const mode = form?.get("mode") === "apply" ? "apply" : "preview";
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 400 });
  }

  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  let table: unknown[][];
  try {
    if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
      table = await parseXlsx(buf);
    } else if (name.endsWith(".csv") || name.endsWith(".txt")) {
      table = parseCsv(buf);
    } else if (name.endsWith(".xls")) {
      return NextResponse.json(
        { error: "unsupported_format", message: "Старый формат .xls не поддерживается — сохраните файл как .xlsx или .csv" },
        { status: 400 },
      );
    } else {
      return NextResponse.json(
        { error: "unsupported_format", message: "Поддерживаются файлы .xlsx и .csv" },
        { status: 400 },
      );
    }
  } catch (e) {
    console.error("[cost-import] parse failed:", e);
    return NextResponse.json(
      { error: "parse_failed", message: "Не удалось прочитать файл — проверьте формат" },
      { status: 400 },
    );
  }

  const { rows, errors } = tableToRows(table);
  if (errors.length) {
    return NextResponse.json({ error: "bad_headers", message: errors[0] }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, total: rows.length });
  }

  const { data: products, error: prodErr } = await admin
    .from("products")
    .select("id, nm_id, vendor_code, title, cost_price")
    .eq("store_id", DEMO_STORE_ID);
  if (prodErr) {
    console.error("[cost-import] products read failed:", prodErr);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  const byNm = new Map((products ?? []).map((p) => [Number(p.nm_id), p]));
  const byVendor = new Map(
    (products ?? [])
      .filter((p) => p.vendor_code)
      .map((p) => [String(p.vendor_code).trim().toLowerCase(), p]),
  );

  const matched: MatchedRow[] = [];
  const unmatched: UnmatchedRow[] = [];
  const seen = new Set<string>(); // дубль товара в файле — берём первую строку

  for (const r of rows) {
    const label = r.nmId ? String(r.nmId) : (r.vendorCode ?? `строка ${r.line}`);
    if (r.costPrice == null || r.costPrice < 0) {
      unmatched.push({ line: r.line, value: label, reason: "не распознана себестоимость" });
      continue;
    }
    if (r.costPrice === 0) {
      unmatched.push({ line: r.line, value: label, reason: "нулевая себестоимость — пропущено" });
      continue;
    }
    const product =
      (r.nmId ? byNm.get(r.nmId) : undefined) ??
      (r.vendorCode ? byVendor.get(r.vendorCode.toLowerCase()) : undefined);
    if (!product) {
      unmatched.push({ line: r.line, value: label, reason: "товар не найден в CRM" });
      continue;
    }
    if (seen.has(product.id as string)) {
      unmatched.push({ line: r.line, value: label, reason: "дубль в файле — взята первая строка" });
      continue;
    }
    seen.add(product.id as string);
    matched.push({
      productId: product.id as string,
      nmId: Number(product.nm_id),
      title: String(product.title),
      oldCost: Number(product.cost_price ?? 0),
      newCost: Math.round(r.costPrice * 100) / 100,
    });
  }

  if (mode === "preview") {
    return NextResponse.json({
      ok: true,
      mode,
      total: rows.length,
      matched: matched.slice(0, 1000),
      unmatched: unmatched.slice(0, 300),
    });
  }

  // apply
  if (!matched.length) {
    return NextResponse.json({ error: "nothing_to_apply" }, { status: 400 });
  }
  const nowIso = new Date().toISOString();
  const APPLY_CHUNK = 25;
  for (let i = 0; i < matched.length; i += APPLY_CHUNK) {
    const results = await Promise.all(
      matched.slice(i, i + APPLY_CHUNK).map((m) =>
        admin
          .from("products")
          .update({
            cost_price: m.newCost,
            cost_price_source: "import",
            cost_price_updated_at: nowIso,
          })
          .eq("id", m.productId),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      console.error("[cost-import] update failed:", failed.error);
      return NextResponse.json({ error: "db_error" }, { status: 500 });
    }
  }

  const { error: histErr } = await admin.from("product_cost_history").insert(
    matched.map((m) => ({
      product_id: m.productId,
      cost_price: m.newCost,
      source: "import",
      created_by: UUID.test(session.user.id) ? session.user.id : null,
    })),
  );
  if (histErr) console.error("[cost-import] history insert failed:", histErr);

  invalidateWbData(...PRODUCT_SCOPES);
  return NextResponse.json({
    ok: true,
    mode,
    applied: matched.length,
    skipped: unmatched.length,
  });
}
