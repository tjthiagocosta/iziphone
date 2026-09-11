'use client';

import { MessageSquare, Phone, Search, Shield } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useHasRole } from '@/components/auth/PermissionGate';
import { StatusIndicator } from '@/components/layout/StatusIndicator';
import { useAuth } from '@/components/providers/AuthProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { initialsOf } from '@/lib/initials';

interface NavbarProps {
  onOpenDialer: () => void;
}

export function Navbar({ onOpenDialer }: NavbarProps) {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const canOpenAdmin = useHasRole(['ADMIN']);

  const handleNewMessage = () => {
    router.push('/app/messages/new');
  };

  const displayName = user
    ? user.name || user.email.split('@')[0] || user.email
    : '';
  const initials = user ? initialsOf(user.name, user.email) : '';

  return (
    <header className="h-14 border-b border-border bg-background flex items-center px-4 gap-4">
      {/* Logo */}
      <Link href="/app" className="flex items-center gap-2 mr-2">
        <div className="w-8 h-8 rounded-lg bg-purple flex items-center justify-center">
          <span className="text-white font-bold text-sm">iz</span>
        </div>
      </Link>

      {/* Action Icons */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
              onClick={onOpenDialer}
            >
              <Phone className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Make a call</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
              onClick={handleNewMessage}
            >
              <MessageSquare className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Send a message</TooltipContent>
        </Tooltip>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Search */}
      <div className="relative w-72">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search iziphone"
          className="pl-9 h-9 bg-secondary border-0 focus-visible:ring-1"
        />
      </div>

      {/* Status Indicator & User Menu */}
      <div className="flex items-center gap-2">
        <StatusIndicator />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 w-9 rounded-full p-0">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-green-500 text-white text-sm">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">{displayName}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/settings/sessions')}>
              Settings
            </DropdownMenuItem>
            {canOpenAdmin && (
              <DropdownMenuItem onClick={() => router.push('/admin')}>
                <Shield className="mr-2 h-4 w-4" />
                Admin Panel
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void signOut()}
              className="text-destructive"
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
