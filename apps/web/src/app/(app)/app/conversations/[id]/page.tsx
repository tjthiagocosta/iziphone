'use client';

import { use } from 'react';
import { ConversationView } from '@/components/conversation/ConversationView';
import { mockContacts, mockRecentInteractions } from '@/lib/mock-data';

interface ConversationPageProps {
  params: Promise<{ id: string }>;
}

export default function ConversationPage({ params }: ConversationPageProps) {
  const { id } = use(params);

  // Find contact by ID
  const contact = mockContacts.find((c) => c.id === id);

  if (!contact) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Contact not found</p>
      </div>
    );
  }

  // Filter interactions for this contact
  const interactions = mockRecentInteractions.filter(
    (i) => i.contact.id === id,
  );

  return <ConversationView contact={contact} interactions={interactions} />;
}
