'use client';

import {
  Copy,
  ExternalLink,
  MoreVertical,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Share2,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  formatDuration,
  formatPhoneNumber,
  type MockInteraction,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

interface InteractionCardProps {
  interaction: MockInteraction;
}

export function InteractionCard({ interaction }: InteractionCardProps) {
  const {
    contact,
    type,
    direction,
    status,
    duration,
    summary,
    category,
    timestamp,
    content,
  } = interaction;

  const isMissed =
    status === 'missed' || status === 'no-answer' || status === 'busy';

  // Format time for display
  const timeString = timestamp.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // Get call title
  const getCallTitle = () => {
    if (isMissed) {
      return `Missed call with ${contact.name?.split(' ')[0] || 'Unknown'}`;
    }
    if (direction === 'inbound') {
      return `${contact.name?.split(' ')[0] || 'Unknown'} called you`;
    }
    return `You called ${contact.name?.split(' ')[0] || 'Unknown'}`;
  };

  // Get call icon
  const CallIcon = isMissed
    ? PhoneMissed
    : direction === 'inbound'
      ? PhoneIncoming
      : PhoneOutgoing;

  if (type === 'message') {
    // Message card
    return (
      <div className="flex gap-3 group">
        <Avatar className="h-8 w-8 mt-1">
          <AvatarFallback
            className={cn(contact.avatarColor, 'text-white text-sm')}
          >
            {contact.initials}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">
              {contact.name || formatPhoneNumber(contact.phoneNumber)}
            </span>
            <span className="text-xs text-muted-foreground">{timeString}</span>
          </div>

          <div className="mt-1 bg-card rounded-lg p-3 max-w-md">
            <p className="text-sm">{content}</p>
          </div>
        </div>

        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-start gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ExternalLink className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Copy message</DropdownMenuItem>
              <DropdownMenuItem>Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }

  // Call/Voicemail card
  return (
    <div className="flex gap-3 group">
      <Avatar className="h-8 w-8 mt-1">
        <AvatarFallback
          className={cn(contact.avatarColor, 'text-white text-sm')}
        >
          {contact.initials}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">
            {contact.name || formatPhoneNumber(contact.phoneNumber)}
          </span>
          <span className="text-xs text-muted-foreground">{timeString}</span>
        </div>

        <div className="mt-1 bg-card rounded-lg p-3 max-w-lg">
          {/* Call header */}
          <div className="flex items-start gap-2">
            <CallIcon
              className={cn(
                'h-4 w-4 mt-0.5',
                isMissed ? 'text-destructive' : 'text-muted-foreground',
              )}
            />
            <div className="flex-1">
              <p
                className={cn(
                  'font-medium text-sm',
                  isMissed && 'text-destructive',
                )}
              >
                {getCallTitle()}
              </p>
              <p className="text-xs text-muted-foreground">
                Other {formatPhoneNumber(interaction.from)} → iziphone{' '}
                {formatPhoneNumber(interaction.to)}
              </p>
              {duration && !isMissed && (
                <p className="text-xs text-muted-foreground mt-1">
                  Lasted {formatDuration(duration)} • Ended at {timeString}
                </p>
              )}
            </div>

            {/* Action buttons - visible on hover */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Share2 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>View details</DropdownMenuItem>
                  <DropdownMenuItem>Download recording</DropdownMenuItem>
                  <DropdownMenuItem>Add note</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* AI Summary */}
          {summary && (
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Summary
              </p>
              <p className="text-sm text-muted-foreground">{summary}</p>
              {category && (
                <Badge
                  variant="outline"
                  className="mt-2 text-xs bg-orange-500/10 text-orange-400 border-orange-500/20"
                >
                  {category}
                </Badge>
              )}
              <p className="text-[10px] text-muted-foreground/50 mt-2 text-right">
                Powered by iziphone AI
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
