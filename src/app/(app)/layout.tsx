import { AppHeader } from "@/frontend/components/layout/app-header";
import { AppSidebar } from "@/frontend/components/layout/app-sidebar";
import { ChatWidget } from "@/frontend/components/ai/chat-widget";
import { getSession } from "@/backend/auth/session";
import { aiConfigured } from "@/backend/ai/assistant";
import { dataSource } from "@/backend/data";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <div className="flex h-svh overflow-hidden">
      <AppSidebar role={session.role} dataSource={dataSource()} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader session={session} />
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
      {aiConfigured() && <ChatWidget userName={session.user.name} />}
    </div>
  );
}
