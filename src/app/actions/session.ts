"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isMemberRole } from "@/shared/rbac";
import { DEMO_ROLE_COOKIE } from "@/backend/auth/session";

export async function setDemoRole(role: string) {
  if (!isMemberRole(role)) return;
  const cookieStore = await cookies();
  cookieStore.set(DEMO_ROLE_COOKIE, role, {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  revalidatePath("/", "layout");
}
