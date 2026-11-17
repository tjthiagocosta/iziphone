'use client';

import type { PhoneNumberResponse } from '@repo/dto';
import {
  Archive,
  ArrowRightLeft,
  MoreHorizontal,
  Settings2,
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
import { formatPhoneNumber } from '@/lib/phone-number';
import { NUMBER_TYPE_LABELS } from '@/lib/phone-numbers/number-terms';
import { CapabilityBadges } from './CapabilityBadges';

interface PhoneNumberTableProps {
  phoneNumbers: PhoneNumberResponse[];
  isLoading?: boolean;
  onMove: (phoneNumber: PhoneNumberResponse) => void;
  onMoveToReserve: (phoneNumber: PhoneNumberResponse) => void;
  onRelease: (phoneNumber: PhoneNumberResponse) => void;
}

export function PhoneNumberTable({
  phoneNumbers,
  isLoading,
  onMove,
  onMoveToReserve,
  onRelease,
}: PhoneNumberTableProps) {
  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Number</TableHead>
            <TableHead>Assigned to</TableHead>
            <TableHead className="hidden md:table-cell">Type</TableHead>
            <TableHead className="hidden lg:table-cell">Capabilities</TableHead>
            <TableHead className="w-[52px]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading
            ? Array.from(
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
                    <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="h-5 w-24 bg-muted animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="h-8 w-8 bg-muted animate-pulse rounded" />
                  </TableCell>
                </TableRow>
              ))
            : phoneNumbers.map((phone) => (
                <PhoneNumberRow
                  key={phone.id}
                  phone={phone}
                  onMove={onMove}
                  onMoveToReserve={onMoveToReserve}
                  onRelease={onRelease}
                />
              ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PhoneNumberRow({
  phone,
  onMove,
  onMoveToReserve,
  onRelease,
}: {
  phone: PhoneNumberResponse;
  onMove: (phoneNumber: PhoneNumberResponse) => void;
  onMoveToReserve: (phoneNumber: PhoneNumberResponse) => void;
  onRelease: (phoneNumber: PhoneNumberResponse) => void;
}) {
  const place = [phone.locality, phone.region].filter(Boolean).join(', ');

  return (
    <TableRow>
      <TableCell className="align-top">
        <Link
          href={`/admin/phone-numbers/${phone.id}`}
          className="font-mono font-medium hover:underline whitespace-nowrap"
        >
          {formatPhoneNumber(phone.phoneNumber)}
        </Link>
        {phone.label && (
          <span className="block text-sm text-muted-foreground">
            {phone.label}
          </span>
        )}
        {place && (
          <span className="block text-xs text-muted-foreground">{place}</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        {phone.assignedTo ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm">{phone.assignedTo.name}</span>
            <Badge
              variant={
                phone.assignedTo.type === 'department' ? 'default' : 'secondary'
              }
              className="text-xs"
            >
              {phone.assignedTo.type === 'department' ? 'Department' : 'User'}
            </Badge>
            {phone.isPrimary && (
              <Badge variant="outline" className="text-xs">
                Primary
              </Badge>
            )}
          </div>
        ) : phone.status === 'RELEASED' ? (
          <Badge variant="destructive">Release unfinished</Badge>
        ) : (
          <Badge variant="outline">In reserve</Badge>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell align-top">
        <Badge variant="outline">{NUMBER_TYPE_LABELS[phone.type]}</Badge>
      </TableCell>
      <TableCell className="hidden lg:table-cell align-top">
        <CapabilityBadges
          voice={phone.voiceEnabled}
          sms={phone.smsEnabled}
          mms={phone.mmsEnabled}
          fax={phone.faxEnabled}
        />
      </TableCell>
      <TableCell className="align-top">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`Actions for ${formatPhoneNumber(phone.phoneNumber)}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/admin/phone-numbers/${phone.id}`}>
                <Settings2 className="mr-2 h-4 w-4" />
                Manage
              </Link>
            </DropdownMenuItem>
            {phone.status !== 'RELEASED' && (
              <DropdownMenuItem onClick={() => onMove(phone)}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                {phone.assignedTo ? 'Move to...' : 'Assign to...'}
              </DropdownMenuItem>
            )}
            {phone.assignedTo ? (
              <DropdownMenuItem onClick={() => onMoveToReserve(phone)}>
                <Archive className="mr-2 h-4 w-4" />
                Move to reserve
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onRelease(phone)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {phone.status === 'RELEASED'
                    ? 'Finish release'
                    : 'Release number'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
