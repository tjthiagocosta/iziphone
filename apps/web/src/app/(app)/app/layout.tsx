import { MainLayout } from '@/components/layout/MainLayout';
import { CallProvider } from '@/components/providers/CallProvider';
import { UnreadMessagesProvider } from '@/components/providers/UnreadMessagesProvider';

export default function MainAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CallProvider>
      <UnreadMessagesProvider>
        <MainLayout>{children}</MainLayout>
      </UnreadMessagesProvider>
    </CallProvider>
  );
}
