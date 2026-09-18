'use client';

import type {
  AccessLinkResponse,
  CreateUser,
  Role,
  UserResponse,
} from '@repo/dto';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import { AccessLinkDialog } from '@/components/admin/users/AccessLinkDialog';
import { InviteUserDialog } from '@/components/admin/users/InviteUserDialog';
import { UserTable } from '@/components/admin/users/UserTable';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUserMutations, useUsers } from '@/hooks/use-admin-users';

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function UsersPage() {
  const searchParams = useSearchParams();
  const [isCreateOpen, setIsCreateOpen] = useState(
    searchParams.get('action') === 'create',
  );
  const [userToDelete, setUserToDelete] = useState<UserResponse | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');

  const [issued, setIssued] = useState<{
    link: AccessLinkResponse;
    recipient: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { users, page, totalPages, isLoading, setQuery, refetch } = useUsers();

  const {
    invite,
    resendInvite,
    sendPasswordReset,
    remove,
    isLoading: isMutating,
  } = useUserMutations();

  useEffect(() => {
    setQuery({
      page: 1,
      search: search || undefined,
      role: roleFilter === 'all' ? undefined : roleFilter,
    });
  }, [search, roleFilter, setQuery]);

  const handleInvite = async (data: CreateUser) => {
    const invited = await invite(data);
    setIssued({ link: invited.invite, recipient: invited.user.email });
    refetch();
  };

  /*
   * These two are started from a menu rather than a form, so nothing else is
   * there to catch a refusal: an admin who clicks and sees nothing would not
   * know whether the link went out.
   */
  const handleResendInvite = async (user: UserResponse) => {
    setActionError(null);
    try {
      const link = await resendInvite(user.id);
      setIssued({ link, recipient: user.email });
      refetch();
    } catch (error) {
      setActionError(messageFor(error, 'Could not send the invite.'));
    }
  };

  const handleSendPasswordReset = async (user: UserResponse) => {
    setActionError(null);
    try {
      const link = await sendPasswordReset(user.id);
      setIssued({ link, recipient: user.email });
    } catch (error) {
      setActionError(messageFor(error, 'Could not send the reset link.'));
    }
  };

  const handleDelete = async () => {
    if (!userToDelete) return;
    await remove(userToDelete.id);
    setUserToDelete(null);
    refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-muted-foreground">Manage your team members</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Invite User
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex-1 max-w-sm">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search users..."
          />
        </div>
        <Select
          value={roleFilter}
          onValueChange={(value) => setRoleFilter(value as Role | 'all')}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="ADMIN">Admin</SelectItem>
            <SelectItem value="SUPERVISOR">Supervisor</SelectItem>
            <SelectItem value="AGENT">Agent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {actionError && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
          {actionError}
        </div>
      )}

      <UserTable
        users={users}
        isLoading={isLoading}
        onDelete={setUserToDelete}
        onResendInvite={handleResendInvite}
        onSendPasswordReset={handleSendPasswordReset}
      />

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(newPage) => setQuery({ page: newPage })}
        />
      )}

      <InviteUserDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleInvite}
        isLoading={isMutating}
      />

      <AccessLinkDialog
        link={issued?.link ?? null}
        recipient={issued?.recipient ?? null}
        onClose={() => setIssued(null)}
      />

      <ConfirmDialog
        open={!!userToDelete}
        onOpenChange={(open) => !open && setUserToDelete(null)}
        title="Delete User"
        description={`Are you sure you want to delete "${userToDelete?.name || userToDelete?.email}"? This action can be undone from the Deleted Users page.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={isMutating}
      />
    </div>
  );
}
