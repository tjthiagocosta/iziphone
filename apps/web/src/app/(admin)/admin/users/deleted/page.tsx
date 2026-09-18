'use client';

import type { AccessLinkResponse, UserResponse } from '@repo/dto';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import { AccessLinkDialog } from '@/components/admin/users/AccessLinkDialog';
import { UserTable } from '@/components/admin/users/UserTable';
import { useUserMutations, useUsers } from '@/hooks/use-admin-users';

export default function DeletedUsersPage() {
  const [userToRestore, setUserToRestore] = useState<UserResponse | null>(null);
  const [search, setSearch] = useState('');
  const [issued, setIssued] = useState<{
    link: AccessLinkResponse;
    recipient: string;
  } | null>(null);

  const { users, page, totalPages, isLoading, setQuery, refetch } = useUsers({
    initialQuery: { deletedOnly: true },
  });

  const { restore, isLoading: isMutating, error } = useUserMutations();

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setQuery({ page: 1, search: value || undefined, deletedOnly: true });
  };

  const handleRestore = async () => {
    if (!userToRestore) return;

    const target = userToRestore;
    setUserToRestore(null);

    try {
      const restored = await restore(target.id);
      // Their password went with the deletion, so the link is how they get
      // back in; an admin who never sees it has restored an account nobody
      // can sign into.
      setIssued({ link: restored.invite, recipient: restored.user.email });
    } catch {
      // `error` from the hook carries the reason; the banner below shows it.
    }

    refetch();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deleted Users</h1>
        <p className="text-muted-foreground">View and restore deleted users</p>
      </div>

      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
          {error.message}
        </div>
      )}

      <div className="max-w-sm">
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search deleted users..."
        />
      </div>

      <UserTable
        users={users}
        isLoading={isLoading}
        showDeleted
        onRestore={setUserToRestore}
      />

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(newPage) =>
            setQuery({ page: newPage, deletedOnly: true })
          }
        />
      )}

      <ConfirmDialog
        open={!!userToRestore}
        onOpenChange={(open) => !open && setUserToRestore(null)}
        title="Restore User"
        description={`Restore "${userToRestore?.name || userToRestore?.email}"? Deleting them took their password away, so they get a new invite link to choose one.`}
        confirmLabel="Restore"
        onConfirm={handleRestore}
        isLoading={isMutating}
      />

      <AccessLinkDialog
        link={issued?.link ?? null}
        recipient={issued?.recipient ?? null}
        onClose={() => setIssued(null)}
      />
    </div>
  );
}
