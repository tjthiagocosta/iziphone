'use client';

import type { DepartmentListItem } from '@repo/dto';
import { MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface DepartmentTableProps {
  departments: DepartmentListItem[];
  isLoading?: boolean;
  showDeleted?: boolean;
  onDelete?: (department: DepartmentListItem) => void;
  onRestore?: (department: DepartmentListItem) => void;
}

export function DepartmentTable({
  departments,
  isLoading,
  showDeleted = false,
  onDelete,
  onRestore,
}: DepartmentTableProps) {
  if (isLoading) {
    return (
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Phone Number</TableHead>
              <TableHead>Agents</TableHead>
              <TableHead>Timezone</TableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(
              { length: 5 },
              (_, index) => `department-skeleton-${index + 1}`,
            ).map((rowId) => (
              <TableRow key={rowId}>
                <TableCell>
                  <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-48 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-28 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-12 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-8 w-8 bg-muted animate-pulse rounded" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (departments.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center">
        <p className="text-muted-foreground">
          {showDeleted
            ? 'No deleted departments found'
            : 'No departments found'}
        </p>
      </div>
    );
  }

  const renderRow = (dept: DepartmentListItem) => (
    <TableRow key={dept.id} className="cursor-pointer">
      <TableCell className="font-medium">
        <Link
          href={`/admin/departments/${dept.id}`}
          className="hover:underline"
        >
          {dept.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[300px] truncate">
        {dept.description || '-'}
      </TableCell>
      <TableCell>
        {dept.primaryPhoneNumber ? (
          <span className="font-mono text-sm">{dept.primaryPhoneNumber}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="secondary">{dept.agentCount}</Badge>
      </TableCell>
      <TableCell className="text-sm">
        {dept.timezone || 'America/Chicago'}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showDeleted ? (
              <DropdownMenuItem onClick={() => onRestore?.(dept)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Restore
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem asChild>
                  <Link href={`/admin/departments/${dept.id}`}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDelete?.(dept)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Phone Number</TableHead>
            <TableHead>Agents</TableHead>
            <TableHead>Timezone</TableHead>
            <TableHead className="w-[70px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {departments.map((dept) =>
            showDeleted ? (
              renderRow(dept)
            ) : (
              <ContextMenu key={dept.id}>
                <ContextMenuTrigger asChild>
                  {renderRow(dept)}
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem asChild>
                    <Link href={`/admin/departments/${dept.id}`}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </Link>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive"
                    onClick={() => onDelete?.(dept)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ),
          )}
        </TableBody>
      </Table>
    </div>
  );
}
