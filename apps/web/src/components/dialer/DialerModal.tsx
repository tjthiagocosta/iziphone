'use client';

import { Ban, ChevronDown, Delete, Phone, Search } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  formatPhoneNumber,
  mockContacts,
  mockCurrentUser,
  mockDepartments,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

interface DialerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CallerType = 'personal' | 'department';

interface CallerSelection {
  type: CallerType;
  id: string;
  name: string;
  color: string;
  initials?: string;
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

export function DialerModal({ open, onOpenChange }: DialerModalProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedCaller, setSelectedCaller] = useState<CallerSelection>({
    type: 'personal',
    id: mockCurrentUser.id,
    name: mockCurrentUser.name,
    color: mockCurrentUser.avatarColor,
    initials: mockCurrentUser.initials,
  });
  const [selectedCallerId, setSelectedCallerId] = useState(
    mockCurrentUser.phoneNumber,
  );
  const [blockCallerId, setBlockCallerId] = useState(false);

  // Get available caller IDs based on selection
  const availableCallerIds =
    selectedCaller.type === 'personal'
      ? [{ number: mockCurrentUser.phoneNumber, isDefault: true }]
      : mockDepartments.find((d) => d.id === selectedCaller.id)?.phoneNumbers ||
        [];

  // Recent contacts for quick dial (first 6)
  const recentContacts = mockContacts.slice(0, 6);

  const handleKeyPress = useCallback((digit: string) => {
    setPhoneNumber((prev) => prev + digit);
  }, []);

  const handleBackspace = useCallback(() => {
    setPhoneNumber((prev) => prev.slice(0, -1));
  }, []);

  const { makeCall, deviceStatus } = useCall();

  const handleCall = useCallback(async () => {
    if (phoneNumber.trim() && deviceStatus === 'ready') {
      await makeCall(phoneNumber);
      onOpenChange(false);
    }
  }, [phoneNumber, deviceStatus, makeCall, onOpenChange]);

  const handleSelectCaller = (caller: CallerSelection) => {
    setSelectedCaller(caller);
    // Reset caller ID to default when changing caller
    if (caller.type === 'personal') {
      setSelectedCallerId(mockCurrentUser.phoneNumber);
    } else {
      const dept = mockDepartments.find((d) => d.id === caller.id);
      const defaultNumber = dept?.phoneNumbers.find((p) => p.isDefault);
      setSelectedCallerId(
        defaultNumber?.number || dept?.phoneNumbers[0]?.number || '',
      );
    }
    setBlockCallerId(false);
  };

  const handleQuickDial = (contact: (typeof mockContacts)[0]) => {
    setPhoneNumber(contact.phoneNumber);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 bg-popover border-border">
        {/* Visually hidden title for screen readers */}
        <DialogTitle className="sr-only">New Call</DialogTitle>

        {/* Header */}
        <div className="p-6 pb-4">
          {/* NEW CALL FROM */}
          <div className="space-y-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              NEW CALL FROM
            </p>

            {/* Caller Selector */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-auto p-0 hover:bg-transparent justify-start gap-3"
                >
                  {selectedCaller.type === 'personal' ? (
                    <Avatar className="h-10 w-10">
                      <AvatarFallback
                        className={cn(selectedCaller.color, 'text-white')}
                      >
                        {selectedCaller.initials}
                      </AvatarFallback>
                    </Avatar>
                  ) : (
                    <div
                      className={cn(
                        'w-10 h-10 rounded-lg',
                        mockDepartments.find((d) => d.id === selectedCaller.id)
                          ?.color || 'bg-purple-600',
                      )}
                    />
                  )}
                  <span className="text-lg font-medium">
                    {selectedCaller.name}
                  </span>
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {/* Personal option */}
                <DropdownMenuItem
                  onClick={() =>
                    handleSelectCaller({
                      type: 'personal',
                      id: mockCurrentUser.id,
                      name: mockCurrentUser.name,
                      color: mockCurrentUser.avatarColor,
                      initials: mockCurrentUser.initials,
                    })
                  }
                  className="gap-3"
                >
                  <Avatar className="h-8 w-8">
                    <AvatarFallback
                      className={cn(
                        mockCurrentUser.avatarColor,
                        'text-white text-sm',
                      )}
                    >
                      {mockCurrentUser.initials}
                    </AvatarFallback>
                  </Avatar>
                  <span>{mockCurrentUser.name}</span>
                </DropdownMenuItem>

                {/* Department options */}
                {mockDepartments.map((dept) => (
                  <DropdownMenuItem
                    key={dept.id}
                    onClick={() =>
                      handleSelectCaller({
                        type: 'department',
                        id: dept.id,
                        name: dept.name,
                        color: dept.color,
                      })
                    }
                    className="gap-3"
                  >
                    <div className={cn('w-8 h-8 rounded', dept.color)} />
                    <span>{dept.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Caller ID Selector */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Your caller ID displays as
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 gap-1 bg-secondary border-border"
                  >
                    {blockCallerId
                      ? 'Blocked'
                      : formatPhoneNumber(selectedCallerId)}
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {availableCallerIds.map((callerId) => (
                    <DropdownMenuItem
                      key={callerId.number}
                      onClick={() => {
                        setSelectedCallerId(callerId.number);
                        setBlockCallerId(false);
                      }}
                      className="justify-between"
                    >
                      <span>
                        {selectedCaller.name}:{' '}
                        {formatPhoneNumber(callerId.number)}
                      </span>
                      {callerId.isDefault && (
                        <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                          DEFAULT
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onClick={() => setBlockCallerId(true)}
                    className="gap-2"
                  >
                    <Ban className="h-4 w-4" />
                    <span>Block caller ID</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* Search Input */}
        <div className="px-6 pb-4">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="type a name or number"
              className="pl-12 h-12 text-lg bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary placeholder:text-muted-foreground/50"
            />
            {phoneNumber && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
                onClick={handleBackspace}
              >
                <Delete className="h-5 w-5" />
              </Button>
            )}
          </div>
        </div>

        {/* Recent Contacts */}
        <div className="px-6 pb-4">
          <div className="flex items-center justify-center gap-4">
            {recentContacts.map((contact) => (
              <button
                type="button"
                key={contact.id}
                onClick={() => handleQuickDial(contact)}
                className="flex flex-col items-center gap-1 group"
              >
                <Avatar className="h-12 w-12 transition-transform group-hover:scale-105">
                  <AvatarFallback
                    className={cn(contact.avatarColor, 'text-white')}
                  >
                    {contact.initials}
                  </AvatarFallback>
                </Avatar>
              </button>
            ))}
          </div>
        </div>

        {/* Keypad */}
        <div className="px-6 pb-6">
          <div className="grid grid-cols-3 gap-4">
            {KEYPAD_KEYS.map((key) => (
              <button
                type="button"
                key={key.digit}
                onClick={() => handleKeyPress(key.digit)}
                className="flex flex-col items-center justify-center h-16 rounded-full hover:bg-secondary transition-colors"
              >
                <span className="text-2xl font-light">{key.digit}</span>
                {key.letters && (
                  <span className="text-[10px] text-muted-foreground tracking-widest">
                    {key.letters}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Call Button */}
          <div className="flex justify-center mt-6">
            <Button
              type="button"
              onClick={handleCall}
              disabled={!phoneNumber.trim() || deviceStatus !== 'ready'}
              className="h-14 w-14 rounded-full bg-green-600 hover:bg-green-700 disabled:bg-muted disabled:text-muted-foreground"
            >
              <Phone className="h-6 w-6" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
