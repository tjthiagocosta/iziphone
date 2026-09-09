'use client';

import { useCall } from '@/components/providers/CallProvider';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface KeypadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const KEYPAD_KEYS = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

/**
 * KeypadModal - DTMF keypad for sending tones during a call
 */
export function KeypadModal({ open, onOpenChange }: KeypadModalProps) {
  const { sendDigits } = useCall();

  const handleKeyPress = (digit: string) => {
    sendDigits(digit);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs p-0 gap-0 bg-popover border-border">
        <DialogTitle className="sr-only">Keypad</DialogTitle>

        <div className="p-6">
          <div className="grid grid-cols-3 gap-3">
            {KEYPAD_KEYS.map((key) => (
              <button
                type="button"
                key={key.digit}
                onClick={() => handleKeyPress(key.digit)}
                className="flex flex-col items-center justify-center h-14 rounded-full hover:bg-secondary transition-colors"
              >
                <span className="text-xl font-light">{key.digit}</span>
                {key.letters && (
                  <span className="text-[9px] text-muted-foreground tracking-widest">
                    {key.letters}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Close button */}
          <div className="flex justify-center mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full"
            >
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
