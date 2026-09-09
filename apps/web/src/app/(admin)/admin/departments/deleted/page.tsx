'use client';

import type { DepartmentListItem } from '@repo/dto';
import { useState } from 'react';
import { DepartmentTable } from '@/components/admin/departments/DepartmentTable';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import {
  useDepartmentMutations,
  useDepartments,
} from '@/hooks/use-admin-departments';

export default function DeletedDepartmentsPage() {
  const [deptToRestore, setDeptToRestore] = useState<DepartmentListItem | null>(
    null,
  );
  const [search, setSearch] = useState('');

  const { departments, page, totalPages, isLoading, setQuery, refetch } =
    useDepartments({
      initialQuery: { deletedOnly: true },
    });

  const { restore, isLoading: isMutating } = useDepartmentMutations();

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setQuery({ page: 1, search: value || undefined, deletedOnly: true });
  };

  const handleRestore = async () => {
    if (!deptToRestore) return;
    await restore(deptToRestore.id);
    setDeptToRestore(null);
    refetch();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deleted Departments</h1>
        <p className="text-muted-foreground">
          View and restore deleted departments
        </p>
      </div>

      <div className="max-w-sm">
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search deleted departments..."
        />
      </div>

      <DepartmentTable
        departments={departments}
        isLoading={isLoading}
        showDeleted
        onRestore={setDeptToRestore}
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
        open={!!deptToRestore}
        onOpenChange={(open) => !open && setDeptToRestore(null)}
        title="Restore Department"
        description={`Are you sure you want to restore "${deptToRestore?.name}"?`}
        confirmLabel="Restore"
        onConfirm={handleRestore}
        isLoading={isMutating}
      />
    </div>
  );
}
