'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { MessageInput } from '@/components/conversation/MessageInput';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  formatPhoneNumber,
  mockContacts,
  mockCurrentUser,
  mockDepartments,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

type FromSelection = {
  type: 'personal' | 'department';
  id: string;
  name: string;
  phoneNumber: string;
};

export function NewMessageView() {
  const [selectedFrom, setSelectedFrom] = useState<FromSelection>({
    type: 'personal',
    id: mockCurrentUser.id,
    name: mockCurrentUser.name,
    phoneNumber: mockCurrentUser.phoneNumber,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecipient, setSelectedRecipient] = useState<
    (typeof mockContacts)[0] | null
  >(null);

  // Split contacts into personal and group (department members)
  const personalContacts = mockContacts.filter((c) => !c.departmentBadge);
  const groupContacts = mockContacts.filter((c) => c.departmentBadge);

  // Filter contacts based on search
  const filterContacts = (contacts: typeof mockContacts) => {
    if (!searchQuery) return contacts;
    const query = searchQuery.toLowerCase();
    return contacts.filter(
      (c) =>
        c.name?.toLowerCase().includes(query) || c.phoneNumber.includes(query),
    );
  };

  const filteredPersonal = filterContacts(personalContacts);
  const filteredGroup = filterContacts(groupContacts);

  const handleSelectRecipient = (contact: (typeof mockContacts)[0]) => {
    setSelectedRecipient(contact);
    setSearchQuery('');
  };

  const handleSendMessage = (message: string) => {
    if (!selectedRecipient) return;
    console.log('Sending message to:', selectedRecipient.phoneNumber, message);
    // TODO: Integrate with API
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <h1 className="text-xl font-semibold mb-4">New Message</h1>

        {/* From selector */}
        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm text-muted-foreground w-12">From:</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto p-0 hover:bg-transparent justify-start gap-2 text-base"
              >
                {selectedFrom.name} (
                {formatPhoneNumber(selectedFrom.phoneNumber)})
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              {/* Personal option */}
              <DropdownMenuItem
                onClick={() =>
                  setSelectedFrom({
                    type: 'personal',
                    id: mockCurrentUser.id,
                    name: mockCurrentUser.name,
                    phoneNumber: mockCurrentUser.phoneNumber,
                  })
                }
              >
                {mockCurrentUser.name} (
                {formatPhoneNumber(mockCurrentUser.phoneNumber)})
              </DropdownMenuItem>

              {/* Department options */}
              {mockDepartments.map((dept) => (
                <DropdownMenuItem
                  key={dept.id}
                  onClick={() =>
                    setSelectedFrom({
                      type: 'department',
                      id: dept.id,
                      name: dept.name,
                      phoneNumber: dept.phoneNumbers[0]?.number || '',
                    })
                  }
                >
                  {dept.name} (
                  {formatPhoneNumber(dept.phoneNumbers[0]?.number || '')})
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* To selector */}
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground w-12">To:</span>
          <div className="flex-1 flex items-center gap-2">
            {selectedRecipient ? (
              <div className="flex items-center gap-2 bg-secondary rounded-full px-3 py-1">
                <span className="text-sm">
                  {selectedRecipient.name ||
                    formatPhoneNumber(selectedRecipient.phoneNumber)}
                </span>
                <Check className="h-4 w-4 text-success" />
                <button
                  type="button"
                  onClick={() => setSelectedRecipient(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="relative flex-1">
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Type a name or number"
                  className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 px-0"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content area */}
      {selectedRecipient ? (
        // Show message compose area
        <div className="flex-1 flex flex-col">
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-lg font-medium">
                Message to{' '}
                {selectedRecipient.name ||
                  formatPhoneNumber(selectedRecipient.phoneNumber)}
              </p>
              <p className="text-sm">Start typing your message below</p>
            </div>
          </div>
          <MessageInput onSend={handleSendMessage} />
        </div>
      ) : (
        // Show contact search
        <div className="flex-1 flex flex-col">
          {/* Contact tabs */}
          <Tabs defaultValue="personal" className="flex-1 flex flex-col">
            <div className="border-b border-border px-6">
              <TabsList className="h-auto bg-transparent gap-6 p-0">
                <TabsTrigger
                  value="personal"
                  className="px-0 py-3 text-sm font-normal data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-info"
                >
                  Personal Contacts{' '}
                  <span className="ml-2 text-muted-foreground">
                    {filteredPersonal.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="group"
                  className="px-0 py-3 text-sm font-normal data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-info"
                >
                  Group Contacts{' '}
                  <span className="ml-2 text-muted-foreground">
                    {filteredGroup.length}
                  </span>
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="personal" className="flex-1 mt-0">
              <ScrollArea className="h-full">
                <div className="p-2">
                  {filteredPersonal.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No contacts found
                    </p>
                  ) : (
                    filteredPersonal.map((contact) => (
                      <ContactItem
                        key={contact.id}
                        contact={contact}
                        onClick={() => handleSelectRecipient(contact)}
                      />
                    ))
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="group" className="flex-1 mt-0">
              <ScrollArea className="h-full">
                <div className="p-2">
                  {filteredGroup.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No contacts found
                    </p>
                  ) : (
                    filteredGroup.map((contact) => (
                      <ContactItem
                        key={contact.id}
                        contact={contact}
                        onClick={() => handleSelectRecipient(contact)}
                      />
                    ))
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>

          {/* Empty state illustration placeholder */}
          {!searchQuery && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-48 h-48 mx-auto mb-4 bg-secondary/50 rounded-lg flex items-center justify-center">
                  <span className="text-6xl text-muted-foreground/30">💬</span>
                </div>
                <p className="text-lg font-medium">What's on your mind?</p>
                <p className="text-sm text-muted-foreground">
                  Enter a name or number to start chatting
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ContactItemProps {
  contact: (typeof mockContacts)[0];
  onClick: () => void;
}

function ContactItem({ contact, onClick }: ContactItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-secondary transition-colors text-left"
    >
      <div className="relative">
        <Avatar className="h-10 w-10">
          <AvatarFallback className={cn(contact.avatarColor, 'text-white')}>
            {contact.initials}
          </AvatarFallback>
        </Avatar>
        {contact.status === 'available' && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-background" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">
            {contact.name || formatPhoneNumber(contact.phoneNumber)}
          </span>
          {contact.departmentBadge && (
            <Badge
              variant="secondary"
              className="text-[10px] bg-purple/10 text-purple border-purple/20"
            >
              {contact.departmentBadge}
            </Badge>
          )}
        </div>
        {contact.name && (
          <p className="text-sm text-muted-foreground truncate">
            {formatPhoneNumber(contact.phoneNumber)}
          </p>
        )}
      </div>

      <span className="text-sm text-muted-foreground">
        {contact.status === 'available'
          ? 'Available'
          : contact.status === 'dnd'
            ? 'DND'
            : ''}
      </span>
    </button>
  );
}
