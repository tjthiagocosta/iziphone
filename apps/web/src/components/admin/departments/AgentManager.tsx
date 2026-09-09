'use client';

import type { DepartmentAgentResponse } from '@repo/dto';
import { Loader2, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { getUsers } from '@/lib/api/admin';

interface UserOption {
  id: string;
  name: string | null;
  email: string;
}

interface AgentManagerProps {
  agents: DepartmentAgentResponse[];
  onAddAgent: (userId: string) => Promise<void>;
  onRemoveAgent: (userId: string) => Promise<void>;
  isLoading?: boolean;
}

export function AgentManager({
  agents,
  onAddAgent,
  onRemoveAgent,
  isLoading = false,
}: AgentManagerProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [availableUsers, setAvailableUsers] = useState<UserOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [addingUserId, setAddingUserId] = useState<string | null>(null);

  // Get IDs of users already in the department
  const existingUserIds = new Set(agents.map((a) => a.userId));

  // Search for users when query changes
  const searchUsers = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const result = await getUsers({ search: query || undefined, limit: 20 });
      setAvailableUsers(
        result.users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
        })),
      );
    } catch (error) {
      console.error('Failed to search users:', error);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Load users when popover opens
  useEffect(() => {
    if (open) {
      searchUsers(searchQuery);
    }
  }, [open, searchQuery, searchUsers]);

  const handleAddAgent = async (userId: string) => {
    setAddingUserId(userId);
    try {
      await onAddAgent(userId);
      setOpen(false);
      setSearchQuery('');
    } finally {
      setAddingUserId(null);
    }
  };

  const handleRemoveAgent = async (userId: string) => {
    setRemovingUserId(userId);
    try {
      await onRemoveAgent(userId);
    } finally {
      setRemovingUserId(null);
    }
  };

  // Filter out users that are already agents
  const filteredUsers = availableUsers.filter(
    (user) => !existingUserIds.has(user.id),
  );

  return (
    <div className="space-y-4">
      {/* Add Agent Button with Search Popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full" disabled={isLoading}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add Agent
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search users by name or email..."
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            <CommandList>
              {isSearching ? (
                <div className="flex items-center justify-center p-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                <>
                  <CommandEmpty>No users found.</CommandEmpty>
                  <CommandGroup>
                    {filteredUsers.map((user) => (
                      <CommandItem
                        key={user.id}
                        value={user.id}
                        onSelect={() => handleAddAgent(user.id)}
                        disabled={addingUserId === user.id}
                      >
                        <div className="flex items-center justify-between w-full">
                          <div>
                            <p className="font-medium">
                              {user.name || user.email}
                            </p>
                            {user.name && (
                              <p className="text-sm text-muted-foreground">
                                {user.email}
                              </p>
                            )}
                          </div>
                          {addingUserId === user.id && (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Current Agents List */}
      {agents.length === 0 ? (
        <p className="text-muted-foreground text-sm text-center py-4">
          No agents assigned to this department
        </p>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <div
              key={agent.userId}
              className="flex items-center justify-between p-3 rounded-md border bg-background"
            >
              <div>
                <p className="font-medium">
                  {agent.userName || agent.userEmail}
                </p>
                <p className="text-sm text-muted-foreground">
                  {agent.userEmail}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => handleRemoveAgent(agent.userId)}
                disabled={removingUserId === agent.userId || isLoading}
              >
                {removingUserId === agent.userId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
