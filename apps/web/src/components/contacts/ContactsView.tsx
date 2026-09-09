'use client';

import { Plus, Search, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  formatPhoneNumber,
  type MockContact,
  mockContacts,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

export function ContactsView() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedContact, setSelectedContact] = useState<MockContact | null>(
    null,
  );
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // Filter contacts based on search
  const filteredContacts = searchQuery
    ? mockContacts.filter(
        (c) =>
          c.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.phoneNumber.includes(searchQuery),
      )
    : mockContacts;

  const handleEditContact = (contact: MockContact) => {
    setSelectedContact(contact);
    setIsEditModalOpen(true);
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">Contacts</h1>
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            Add Contact
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search contacts..."
            className="pl-9 bg-secondary border-0"
          />
        </div>
      </div>

      {/* Contact List */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {filteredContacts.length === 0 ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">No contacts found</p>
            </div>
          ) : (
            filteredContacts.map((contact) => (
              <ContactItem
                key={contact.id}
                contact={contact}
                onEdit={() => handleEditContact(contact)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Edit Contact Modal */}
      <ContactEditModal
        contact={selectedContact}
        open={isEditModalOpen}
        onOpenChange={setIsEditModalOpen}
      />
    </div>
  );
}

interface ContactItemProps {
  contact: MockContact;
  onEdit: () => void;
}

function ContactItem({ contact, onEdit }: ContactItemProps) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full flex items-center gap-4 px-4 py-3 hover:bg-secondary/50 transition-colors text-left"
    >
      {/* Avatar */}
      <div className="relative">
        <Avatar className="h-10 w-10">
          <AvatarFallback className={cn(contact.avatarColor, 'text-white')}>
            {contact.initials}
          </AvatarFallback>
        </Avatar>
        {contact.status === 'available' && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-background" />
        )}
        {contact.status === 'dnd' && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-warning border-2 border-background" />
        )}
      </div>

      {/* Info */}
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
          <p className="text-sm text-muted-foreground">
            {formatPhoneNumber(contact.phoneNumber)}
          </p>
        )}
      </div>

      {/* Status */}
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

interface ContactEditModalProps {
  contact: MockContact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ContactEditModal({
  contact,
  open,
  onOpenChange,
}: ContactEditModalProps) {
  if (!contact) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle>Edit Contact</DialogTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <UserPlus className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          {/* Contact Name */}
          <div className="space-y-2">
            <label htmlFor="contact-name" className="text-sm font-medium">
              Contact Name
            </label>
            <Input
              id="contact-name"
              defaultValue={contact.name || ''}
              placeholder="Enter name"
              className="bg-secondary border-border focus-visible:border-info"
            />
          </div>

          {/* Phone Number */}
          <div className="space-y-2">
            <label
              htmlFor="contact-phone-number"
              className="text-sm font-medium"
            >
              Phone Number
            </label>
            <p className="text-xs text-muted-foreground">
              To add a pause, enter a comma.
            </p>
            <div className="flex gap-2">
              <Input
                id="contact-phone-number"
                defaultValue={contact.phoneNumber}
                placeholder="Enter phone number"
                className="flex-1 bg-secondary border-border focus-visible:border-info"
              />
              <Select defaultValue="other">
                <SelectTrigger className="w-32 bg-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mobile">Mobile</SelectItem>
                  <SelectItem value="work">Work</SelectItem>
                  <SelectItem value="home">Home</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="ghost" size="sm" className="gap-1 text-info">
              <Plus className="h-4 w-4" />
              Add number
            </Button>
          </div>

          {/* Email Address */}
          <div className="space-y-2">
            <label htmlFor="contact-email" className="text-sm font-medium">
              Email Address
            </label>
            <Input
              id="contact-email"
              placeholder="Enter email"
              className="bg-secondary border-border focus-visible:border-info"
            />
            <Button variant="ghost" size="sm" className="gap-1 text-info">
              <Plus className="h-4 w-4" />
              Add email
            </Button>
          </div>

          {/* Company */}
          <div className="space-y-2">
            <label htmlFor="contact-company" className="text-sm font-medium">
              Company
            </label>
            <Input
              id="contact-company"
              placeholder="Enter company"
              className="bg-secondary border-border focus-visible:border-info"
            />
          </div>

          {/* Title */}
          <div className="space-y-2">
            <label htmlFor="contact-title" className="text-sm font-medium">
              Title
            </label>
            <Input
              id="contact-title"
              placeholder="Enter title"
              className="bg-secondary border-border focus-visible:border-info"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
