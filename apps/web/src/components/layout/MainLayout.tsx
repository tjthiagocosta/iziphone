'use client';

import { useState } from 'react';
import { ActiveCallBar, IncomingCallModal } from '@/components/call';
import { DialerModal } from '@/components/dialer/DialerModal';
import { useCall } from '@/components/providers/CallProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const [isDialerOpen, setIsDialerOpen] = useState(false);
  const { callStatus, incomingCall } = useCall();

  const isInCall = callStatus !== 'idle';

  return (
    <TooltipProvider>
      <div className="h-screen flex flex-col bg-background">
        {/* Navbar */}
        <Navbar onOpenDialer={() => setIsDialerOpen(true)} />

        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <Sidebar />

          {/* Content */}
          <main className="flex-1 overflow-auto">{children}</main>
        </div>

        {/* Floating Active Call Bar - shows during calls */}
        {isInCall && <ActiveCallBar />}

        {/* Incoming Call Modal */}
        {incomingCall && <IncomingCallModal />}

        {/* Dialer Modal */}
        <DialerModal open={isDialerOpen} onOpenChange={setIsDialerOpen} />
      </div>
    </TooltipProvider>
  );
}
