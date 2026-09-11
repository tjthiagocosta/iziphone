'use client';

import { use } from 'react';
import { ConversationView } from '@/components/conversation/ConversationView';

interface ConversationPageProps {
  params: Promise<{ id: string }>;
}

/** `id` is a conversation, which is one contact on one of our lines. */
export default function ConversationPage({ params }: ConversationPageProps) {
  const { id } = use(params);

  return <ConversationView conversationId={id} />;
}
