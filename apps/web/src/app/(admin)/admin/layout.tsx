import { AdminSidebar } from '@/components/admin/layout/AdminSidebar';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen flex bg-background">
      <AdminSidebar />
      <main className="flex-1 overflow-auto">
        <div className="py-6 px-6 max-w-7xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
