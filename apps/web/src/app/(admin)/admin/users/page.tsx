'use client';

import type { CreateUser, Role, UserResponse } from '@repo/dto';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import { CreateUserDialog } from '@/components/admin/users/CreateUserDialog';
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

export default function UsersPage() {
  const searchParams = useSearchParams();
  const [isCreateOpen, setIsCreateOpen] = useState(
    searchParams.get('action') === 'create',
  );
  const [userToDelete, setUserToDelete] = useState<UserResponse | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');

  const { users, page, totalPages, isLoading, setQuery, refetch } = useUsers();

  const { create, remove, isLoading: isMutating } = useUserMutations();

  useEffect(() => {
    setQuery({
      page: 1,
      search: search || undefined,
      role: roleFilter === 'all' ? undefined : roleFilter,
    });
  }, [search, roleFilter, setQuery]);

  const handleCreate = async (data: CreateUser) => {
    await create(data);
    refetch();
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
          Create User
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

      <UserTable
        users={users}
        isLoading={isLoading}
        onDelete={setUserToDelete}
      />

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(newPage) => setQuery({ page: newPage })}
        />
      )}

      <CreateUserDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreate}
        isLoading={isMutating}
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
