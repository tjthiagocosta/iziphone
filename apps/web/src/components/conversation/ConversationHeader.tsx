'use client';

import {
  Monitor,
  MoreVertical,
  Phone,
  Search,
  Star,
  UserPlus,
  Video,
} from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatPhoneNumber, type MockContact } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

interface ConversationHeaderProps {
  contact: MockContact;
  onCall?: () => void;
}

export function ConversationHeader({
  contact,
  onCall,
}: ConversationHeaderProps) {
  const [isStarred, setIsStarred] = useState(false);

  return (
    <div className="h-16 border-b border-border flex items-center px-4 gap-4 bg-background">
      {/* Contact Info */}
      <div className="flex items-center gap-3 flex-1">
        <Avatar className="h-10 w-10">
          <AvatarFallback className={cn(contact.avatarColor, 'text-white')}>
            {contact.initials}
          </AvatarFallback>
        </Avatar>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 hover:text-primary transition-colors"
              >
                <span className="font-medium text-lg">
                  {contact.name || formatPhoneNumber(contact.phoneNumber)}
                </span>
                {/* <ChevronDown className="h-4 w-4 text-muted-foreground" /> */}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem>View contact</DropdownMenuItem>
              <DropdownMenuItem>Edit contact</DropdownMenuItem>
              <DropdownMenuItem>Block number</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setIsStarred(!isStarred)}
          >
            <Star
              className={cn(
                'h-4 w-4',
                isStarred
                  ? 'fill-yellow-400 text-yellow-400'
                  : 'text-muted-foreground',
              )}
            />
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Other: {formatPhoneNumber(contact.phoneNumber)}
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Search className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search conversation</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <UserPlus className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add contact</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Video className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Start video call</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Monitor className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Screen share</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Phone className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onCall}>
              Call {contact.name || formatPhoneNumber(contact.phoneNumber)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted-foreground hover:text-foreground"
        >
          <MoreVertical className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
