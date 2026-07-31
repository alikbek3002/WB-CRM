import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { askAssistant, aiConfigured, type ChatMessage } from "@/backend/ai/assistant";
import { buildSnapshot } from "@/backend/ai/snapshot";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";
export const maxDuration = 60;

// Чат с ИИ-ассистентом. История приходит с клиента, снимок данных строится
// по роли сессии на сервере (роль не может подсмотреть чужие данные).
const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4000),
      }),
    )
    .min(1)
    .max(30),
});

export async function POST(request: Request) {
  const session = await getSession();

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (!aiConfigured()) {
    return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const user = {
    id: session.user.id,
    name: session.user.name,
    role: session.role,
    roleLabel: session.roleLabel,
    orgName: session.org.name,
  };

  try {
    const snapshot = await buildSnapshot(admin, user);
    const reply = await askAssistant({
      user,
      snapshot,
      history: parsed.data.messages as ChatMessage[],
      db: admin, // включает инструменты-действия (создать задачу и т.д.)
      // Ассистент пишет в БД так же, как обычные API-роуты, — значит обязан
      // сбросить кэш чтения, иначе страницы покажут данные до действия.
      onMutation: () => invalidateWbData(),
    });
    return NextResponse.json({ reply });
  } catch (e) {
    console.error("[ai/chat] failed:", e);
    return NextResponse.json({ error: "ai_error" }, { status: 502 });
  }
}
