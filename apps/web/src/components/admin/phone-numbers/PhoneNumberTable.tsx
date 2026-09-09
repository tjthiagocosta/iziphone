'use client';

import type { PhoneNumberResponse } from '@repo/dto';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
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

interface PhoneNumberTableProps {
  phoneNumbers: PhoneNumberResponse[];
  isLoading?: boolean;
  onRelease?: (phoneNumber: PhoneNumberResponse) => void;
}

export function PhoneNumberTable({
  phoneNumbers,
  isLoading,
  onRelease,
}: PhoneNumberTableProps) {
  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return 'default';
      case 'RESERVED':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  if (isLoading) {
    return (
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone Number</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead>Assigned To</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(
              { length: 5 },
              (_, index) => `phone-number-skeleton-${index + 1}`,
            ).map((rowId) => (
              <TableRow key={rowId}>
                <TableCell>
                  <div className="space-y-1">
                    <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <div className="h-5 w-10 bg-muted animate-pulse rounded" />
                    <div className="h-5 w-10 bg-muted animate-pulse rounded" />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                </TableCell>
                <TableCell>
                  <div className="h-4 w-20 bg-muted animate-pulse rounded" />
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

  if (phoneNumbers.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center">
        <p className="text-muted-foreground">No phone numbers found</p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Phone Number</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Capabilities</TableHead>
            <TableHead>Assigned To</TableHead>
            <TableHead>Label</TableHead>
            <TableHead className="w-[70px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {phoneNumbers.map((phone) => (
            <TableRow key={phone.id}>
              <TableCell>
                <div>
                  <span className="font-mono">
                    {phone.friendlyName || phone.phoneNumber}
                  </span>
                  {phone.friendlyName && (
                    <span className="block text-xs text-muted-foreground">
                      {phone.phoneNumber}
                    </span>
                  )}
                  {(phone.locality || phone.region) && (
                    <span className="block text-xs text-muted-foreground">
                      {[phone.locality, phone.region]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{phone.type}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={getStatusBadgeVariant(phone.status)}>
                  {phone.status}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {phone.smsEnabled && (
                    <Badge variant="secondary" className="text-xs">
                      SMS
                    </Badge>
                  )}
                  {phone.mmsEnabled && (
                    <Badge variant="secondary" className="text-xs">
                      MMS
                    </Badge>
                  )}
                  {phone.voiceEnabled && (
                    <Badge variant="secondary" className="text-xs">
                      Voice
                    </Badge>
                  )}
                  {!phone.smsEnabled &&
                    !phone.mmsEnabled &&
                    !phone.voiceEnabled && (
                      <span className="text-muted-foreground">-</span>
                    )}
                </div>
              </TableCell>
              <TableCell>
                {phone.assignedTo ? (
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        phone.assignedTo.type === 'user'
                          ? 'secondary'
                          : 'default'
                      }
                    >
                      {phone.assignedTo.type}
                    </Badge>
                    <span className="text-sm">{phone.assignedTo.name}</span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {phone.label || '-'}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/admin/phone-numbers/${phone.id}`}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => onRelease?.(phone)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Release Number
                    </DropdownMenuItem>
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
