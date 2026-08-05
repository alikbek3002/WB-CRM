import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";
import { notifyRoles, tgEsc } from "@/backend/telegram/notify";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Заявка на дизайн карточки: какой товар, что нужно, референсы (design:request)
const createSchema = z.object({
  productId: z.string().regex(UUID).optional().nullable(),
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().max(3000).optional().nullable(),
  referencesText: z.string().trim().max(3000).optional().nullable(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "design:request")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false });
  }

  const { data, error } = await admin
    .from("design_requests")
    .insert({
      org_id: DEMO_ORG_ID,
      product_id: parsed.data.productId ?? null,
      title: parsed.data.title,
      brief: parsed.data.brief || null,
      references_text: parsed.data.referencesText || null,
      status: "new",
      requester_id: UUID.test(session.user.id) ? session.user.id : null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[design] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // Пуш дизайнерам: новая заявка в очереди
  void notifyRoles(
    ["designer", "seo"],
    `🎨 <b>Новая заявка на дизайн</b> от ${tgEsc(session.user.name)}:\n«${tgEsc(parsed.data.title)}»\n\nВзять в работу: CRM → Дизайн`,
  );

  invalidateWbData("design");
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}
