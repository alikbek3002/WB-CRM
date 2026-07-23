import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/backend/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  const supa = await createSupabaseServerClient();
  if (supa) await supa.auth.signOut();
  return NextResponse.json({ ok: true });
}
