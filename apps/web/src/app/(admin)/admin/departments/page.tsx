'use client';

import type { CreateDepartment, DepartmentListItem } from '@repo/dto';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CreateDepartmentDialog } from '@/components/admin/departments/CreateDepartmentDialog';
import { DepartmentTable } from '@/components/admin/departments/DepartmentTable';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import { Button } from '@/components/ui/button';
import {
  useDepartmentMutations,
  useDepartments,
} from '@/hooks/use-admin-departments';

export default function DepartmentsPage() {
  const searchParams = useSearchParams();
  const [isCreateOpen, setIsCreateOpen] = useState(
    searchParams.get('action') === 'create',
  );
  const [deptToDelete, setDeptToDelete] = useState<DepartmentListItem | null>(
    null,
  );
  const [search, setSearch] = useState('');

  const { departments, page, totalPages, isLoading, setQuery, refetch } =
    useDepartments();

  const { create, remove, isLoading: isMutating } = useDepartmentMutations();

  useEffect(() => {
    setQuery({ page: 1, search: search || undefined });
  }, [search, setQuery]);

  const handleCreate = async (data: CreateDepartment) => {
    await create(data);
    refetch();
  };

  const handleDelete = async () => {
    if (!deptToDelete) return;
    await remove(deptToDelete.id);
    setDeptToDelete(null);
    refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Departments</h1>
          <p className="text-muted-foreground">
            Manage your departments and call routing
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Department
        </Button>
      </div>

      <div className="max-w-sm">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search departments..."
        />
      </div>

      <DepartmentTable
        departments={departments}
        isLoading={isLoading}
        onDelete={setDeptToDelete}
      />

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(newPage) => setQuery({ page: newPage })}
        />
      )}

      <CreateDepartmentDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreate}
        isLoading={isMutating}
      />

      <ConfirmDialog
        open={!!deptToDelete}
        onOpenChange={(open) => !open && setDeptToDelete(null)}
        title="Delete Department"
        description={`Are you sure you want to delete "${deptToDelete?.name}"? Phone numbers assigned to this department will be moved to the reserved pool. This action can be undone from the Deleted Departments page.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={isMutating}
      />
    </div>
  );
}
