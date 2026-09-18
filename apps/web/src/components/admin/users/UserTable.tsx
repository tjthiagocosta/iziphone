'use client';

import type { UserResponse } from '@repo/dto';
import {
  KeyRound,
  Mail,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import {
  inviteStatusLabel,
  inviteStatusTone,
  needsInvite,
} from '@/lib/access-link';

interface UserTableProps {
  users: UserResponse[];
  isLoading?: boolean;
  showDeleted?: boolean;
  onDelete?: (user: UserResponse) => void;
  onRestore?: (user: UserResponse) => void;
  /** Sends a fresh invite to somebody who has not set a password yet. */
  onResendInvite?: (user: UserResponse) => void;
  /** Sends a reset link to somebody who is locked out. */
  onSendPasswordReset?: (user: UserResponse) => void;
}

export function UserTable({
  users,
  isLoading,
  showDeleted = false,
  onDelete,
  onRestore,
  onResendInvite,
  onSendPasswordReset,
}: UserTableProps) {
  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case 'ADMIN':
        return 'destructive';
      case 'SUPERVISOR':
        return 'default';
      default:
        return 'secondary';
    }
  };

  if (isLoading) {
    return (
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Departments</TableHead>
              <TableHead>Phone Numbers</TableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(
              { length: 5 },
              (_, index) => `user-skeleton-${index + 1}`,
            ).map((rowId) => (
              <TableRow key={rowId}>
                <TableCell>
                  <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-48 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-5 w-20 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-28 bg-muted animate-pulse rounded" />
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

  if (users.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center">
        <p className="text-muted-foreground">
          {showDeleted ? 'No deleted users found' : 'No users found'}
        </p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Departments</TableHead>
            <TableHead>Phone Numbers</TableHead>
            <TableHead className="w-[70px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/admin/users/${user.id}`}
                  className="hover:underline"
                >
                  {user.name || '-'}
                </Link>
              </TableCell>
              <TableCell>{user.email}</TableCell>
              <TableCell>
                <Badge variant={getRoleBadgeVariant(user.role)}>
                  {user.role}
                </Badge>
              </TableCell>
              <TableCell>
                {/* A deleted user has no access at all; the invite status of
                    one is not a state an admin can act on. */}
                {showDeleted ? (
                  <span className="text-muted-foreground">-</span>
                ) : (
                  <Badge variant={inviteStatusTone(user.inviteStatus)}>
                    {inviteStatusLabel(user.inviteStatus)}
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                {user.departments.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {user.departments.slice(0, 2).map((dept) => (
                      <Badge key={dept.id} variant="outline">
                        {dept.departmentName}
                      </Badge>
                    ))}
                    {user.departments.length > 2 && (
                      <Badge variant="outline">
                        +{user.departments.length - 2}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell>
                {user.phoneNumbers.length > 0 ? (
                  <span className="text-sm">
                    {user.phoneNumbers[0]?.phoneNumber}
                    {user.phoneNumbers.length > 1 && (
                      <span className="text-muted-foreground ml-1">
                        +{user.phoneNumbers.length - 1}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
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
                      <DropdownMenuItem onClick={() => onRestore?.(user)}>
                        <RotateCcw className="mr-2 h-4 w-4" />
                        Restore
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem asChild>
                          <Link href={`/admin/users/${user.id}`}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </Link>
                        </DropdownMenuItem>
                        {needsInvite(user.inviteStatus) ? (
                          <DropdownMenuItem
                            onClick={() => onResendInvite?.(user)}
                          >
                            <Mail className="mr-2 h-4 w-4" />
                            Resend invite
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() => onSendPasswordReset?.(user)}
                          >
                            <KeyRound className="mr-2 h-4 w-4" />
                            Send password reset link
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => onDelete?.(user)}
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
