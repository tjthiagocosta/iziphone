'use client';

import type { UserResponse } from '@repo/dto';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import { UserTable } from '@/components/admin/users/UserTable';
import { useUserMutations, useUsers } from '@/hooks/use-admin-users';

export default function DeletedUsersPage() {
  const [userToRestore, setUserToRestore] = useState<UserResponse | null>(null);
  const [search, setSearch] = useState('');

  const { users, page, totalPages, isLoading, setQuery, refetch } = useUsers({
    initialQuery: { deletedOnly: true },
  });

  const { restore, isLoading: isMutating } = useUserMutations();

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setQuery({ page: 1, search: value || undefined, deletedOnly: true });
  };

  const handleRestore = async () => {
    if (!userToRestore) return;
    await restore(userToRestore.id);
    setUserToRestore(null);
    refetch();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deleted Users</h1>
        <p className="text-muted-foreground">View and restore deleted users</p>
      </div>

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
        description={`Are you sure you want to restore "${userToRestore?.name || userToRestore?.email}"? They will be able to log in again.`}
        confirmLabel="Restore"
        onConfirm={handleRestore}
        isLoading={isMutating}
      />
    </div>
  );
}
