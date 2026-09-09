'use client';

import type {
  PhoneNumberResponse,
  PhoneNumberStatus,
  PhoneNumberType,
  PurchasePhoneNumber,
} from '@repo/dto';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PhoneNumberTable } from '@/components/admin/phone-numbers/PhoneNumberTable';
import { PurchaseNumberDialog } from '@/components/admin/phone-numbers/PurchaseNumberDialog';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Pagination } from '@/components/admin/shared/Pagination';
import { SearchInput } from '@/components/admin/shared/SearchInput';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  usePhoneNumberMutations,
  usePhoneNumbers,
} from '@/hooks/use-admin-phone-numbers';

export default function PhoneNumbersPage() {
  const searchParams = useSearchParams();
  const [isPurchaseOpen, setIsPurchaseOpen] = useState(
    searchParams.get('action') === 'purchase',
  );
  const [numberToRelease, setNumberToRelease] =
    useState<PhoneNumberResponse | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PhoneNumberStatus | 'all'>(
    'all',
  );
  const [typeFilter, setTypeFilter] = useState<PhoneNumberType | 'all'>('all');

  const { phoneNumbers, page, totalPages, isLoading, setQuery, refetch } =
    usePhoneNumbers();

  const {
    purchase,
    release,
    isLoading: isMutating,
  } = usePhoneNumberMutations();

  useEffect(() => {
    setQuery({
      page: 1,
      search: search || undefined,
      status: statusFilter === 'all' ? undefined : statusFilter,
      type: typeFilter === 'all' ? undefined : typeFilter,
    });
  }, [search, statusFilter, typeFilter, setQuery]);

  const handlePurchase = async (data: PurchasePhoneNumber) => {
    await purchase(data);
    await refetch();
  };

  const handleRelease = async () => {
    if (!numberToRelease) return;
    await release(numberToRelease.id);
    setNumberToRelease(null);
    refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Phone Numbers</h1>
          <p className="text-muted-foreground">
            Manage your Twilio phone numbers
          </p>
        </div>
        <Button onClick={() => setIsPurchaseOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Purchase Number
        </Button>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px] max-w-sm">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search phone numbers..."
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setStatusFilter(value as PhoneNumberStatus | 'all')
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="RESERVED">Reserved</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={typeFilter}
          onValueChange={(value) =>
            setTypeFilter(value as PhoneNumberType | 'all')
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="LOCAL">Local</SelectItem>
            <SelectItem value="TOLL_FREE">Toll-Free</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <PhoneNumberTable
        phoneNumbers={phoneNumbers}
        isLoading={isLoading}
        onRelease={setNumberToRelease}
      />

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(newPage) => setQuery({ page: newPage })}
        />
      )}

      <PurchaseNumberDialog
        open={isPurchaseOpen}
        onOpenChange={setIsPurchaseOpen}
        onPurchase={handlePurchase}
        isLoading={isMutating}
      />

      <ConfirmDialog
        open={!!numberToRelease}
        onOpenChange={(open) => !open && setNumberToRelease(null)}
        title="Release Phone Number"
        description={`Are you sure you want to release ${numberToRelease?.phoneNumber}? This will remove the number from Twilio and it cannot be recovered.`}
        confirmLabel="Release"
        variant="destructive"
        onConfirm={handleRelease}
        isLoading={isMutating}
      />
    </div>
  );
}
