'use client';

import { Phone, PhoneOff } from 'lucide-react';
import { useCall } from '@/components/providers/CallProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatPhoneNumber } from '@/lib/phone-number';

/**
 * IncomingCallModal - Full-screen modal for incoming call notifications
 * Uses CallProvider context for state and actions
 */
export function IncomingCallModal() {
  const { incomingCall, answerIncoming, rejectIncoming } = useCall();

  // Don't render if no incoming call
  if (!incomingCall) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-sm mx-4 animate-pulse-ring">
        <CardContent className="pt-6 pb-6 text-center space-y-6">
          {/* Ringing indicator */}
          <div className="flex justify-center">
            <div className="relative">
              <div className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <Phone className="w-10 h-10 text-green-600 dark:text-green-400" />
              </div>
              <div className="absolute inset-0 rounded-full border-4 border-green-500 animate-ping opacity-75" />
            </div>
          </div>

          {/* Caller info */}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Incoming Call</p>
            <p className="text-2xl font-semibold">
              {formatPhoneNumber(incomingCall.from)}
            </p>
            {incomingCall.callerId &&
              incomingCall.callerId !== incomingCall.from && (
                <p className="text-sm text-muted-foreground">
                  {incomingCall.callerId}
                </p>
              )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-4 justify-center">
            <Button
              type="button"
              size="lg"
              variant="destructive"
              className="w-24 h-14 rounded-full"
              onClick={rejectIncoming}
            >
              <PhoneOff className="w-6 h-6" />
            </Button>
            <Button
              type="button"
              size="lg"
              className="w-24 h-14 rounded-full bg-green-600 hover:bg-green-700"
              onClick={answerIncoming}
            >
              <Phone className="w-6 h-6" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
