import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";
import { notifyProfile, notifyRoles, tgEsc } from "@/backend/telegram/notify";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Жизненный цикл заявки на дизайн:
//   take    — дизайнер берёт в работу (new → in_progress), design:submit
//   submit  — дизайнер сдаёт макет (in_progress → review, ссылка обязательна), design:submit
//   approve — утверждение (review → done), design:approve
//   return  — вернуть на доработку (review → in_progress, комментарий обязателен), design:approve
//   cancel  — отменить заявку (→ rejected), design:approve
const actionSchema = z.object({
  action: z.enum(["take", "submit", "approve", "return", "cancel"]),
  resultUrl: z.string().trim().url().max(500).optional(),
  comment: z.string().trim().max(2000).optional(),
});

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  take: { from: ["new"], to: "in_progress" },
  submit: { from: ["in_progress", "new"], to: "review" },
  approve: { from: ["review"], to: "done" },
  return: { from: ["review"], to: "in_progress" },
  cancel: { from: ["new", "in_progress", "review"], to: "rejected" },
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { action, resultUrl, comment } = parsed.data;

  const needed =
    action === "take" || action === "submit" ? "design:submit" : "design:approve";
  if (!can(session.role, needed)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (action === "submit" && !resultUrl) {
    return NextResponse.json({ error: "result_url_required" }, { status: 400 });
  }
  if (action === "return" && !comment) {
    return NextResponse.json({ error: "comment_required" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin || !UUID.test(id)) {
    return NextResponse.json({ ok: true, persisted: false });
  }

  const { data: reqRow, error: readErr } = await admin
    .from("design_requests")
    .select("id, status, title, requester_id, assignee_id")
    .eq("id", id)
    .single();
  if (readErr || !reqRow) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const transition = TRANSITIONS[action];
  if (!transition.from.includes(reqRow.status as string)) {
    return NextResponse.json(
      { error: "invalid_transition", from: reqRow.status, action },
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = { status: transition.to };
  if (action === "take" && UUID.test(session.user.id)) {
    patch.assignee_id = session.user.id;
  }
  if (action === "submit") {
    patch.result_url = resultUrl;
    patch.result_comment = comment || null;
    if (UUID.test(session.user.id)) patch.assignee_id = session.user.id;
  }
  if (action === "approve" || action === "return" || action === "cancel") {
    patch.review_comment = comment || null;
  }

  const { error: updErr } = await admin
    .from("design_requests")
    .update(patch)
    .eq("id", id);
  if (updErr) {
    console.error("[design] update failed:", updErr);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // Пуши по событиям цикла (best effort)
  const title = tgEsc(reqRow.title);
  const who = tgEsc(session.user.name);
  if (action === "submit") {
    // макет сдан → заказчику и руководству на утверждение
    if (reqRow.requester_id) {
      void notifyProfile(
        String(reqRow.requester_id),
        `🎨 <b>Макет готов</b>: «${title}»\nДизайнер: ${who}. Смотреть: CRM → Дизайн → На проверке`,
      );
    }
    void notifyRoles(
      ["owner", "manager"],
      `🎨 Макет «${title}» ждёт утверждения (сдал: ${who}). CRM → Дизайн`,
    );
  } else if ((action === "approve" || action === "return") && reqRow.assignee_id) {
    void notifyProfile(
      String(reqRow.assignee_id),
      action === "approve"
        ? `✅ <b>Дизайн утверждён</b>: «${title}» (${who})${comment ? `\nКомментарий: ${tgEsc(comment)}` : ""}`
        : `↩️ <b>Дизайн вернули на доработку</b>: «${title}» (${who})\nКомментарий: ${tgEsc(comment ?? "")}`,
    );
  }

  invalidateWbData("design");
  return NextResponse.json({ ok: true, persisted: true, status: transition.to });
}
