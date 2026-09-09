import { MainLayout } from '@/components/layout/MainLayout';
import { CallProvider } from '@/components/providers/CallProvider';

export default function MainAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CallProvider>
      <MainLayout>{children}</MainLayout>
    </CallProvider>
  );
}
