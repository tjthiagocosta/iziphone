'use client';

import {
  type ImportPhoneNumber,
  type PhoneNumberListQuery,
  type PhoneNumberOwner,
  type PhoneNumberResponse,
  type PhoneNumberType,
  type PurchasePhoneNumber,
  TelephonyProviderSchema,
} from '@repo/dto';
import { Download, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ImportNumberDialog } from '@/components/admin/phone-numbers/ImportNumberDialog';
import { MoveNumberDialog } from '@/components/admin/phone-numbers/MoveNumberDialog';
import { PhoneNumberTable } from '@/components/admin/phone-numbers/PhoneNumberTable';
import { PurchaseNumberDialog } from '@/components/admin/phone-numbers/PurchaseNumberDialog';
import { ReleaseNumberDialog } from '@/components/admin/phone-numbers/ReleaseNumberDialog';
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
  usePhoneNumber,
  usePhoneNumberMutations,
  usePhoneNumbers,
} from '@/hooks/use-admin-phone-numbers';
import { ApiError } from '@/lib/api/client';
import {
  importNotice,
  purchaseNotice,
  releaseNotice,
} from '@/lib/phone-numbers/number-terms';
import { ownerOf } from '@/lib/phone-numbers/owner-selection';

type AssignedToFilter = NonNullable<PhoneNumberListQuery['assignedTo']>;

interface MoveRequest {
  phoneNumber: PhoneNumberResponse;
  toReserve: boolean;
}

interface Notice {
  message: string;
  /** The number the notice is about, linked from it. */
  phoneNumberId?: string;
}

/**
 * A number's page sends the admin here, naming the number's provider, after a
 * release Twilio had nothing to cancel for.
 */
function noticeFromLink(released: string | null): Notice | null {
  const provider = TelephonyProviderSchema.safeParse(released);
  const message = provider.success
    ? releaseNotice({ cancelledAtTwilio: false }, provider.data)
    : null;

  return message ? { message } : null;
}

export default function PhoneNumbersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPurchaseOpen, setIsPurchaseOpen] = useState(
    searchParams.get('action') === 'purchase',
  );
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null);
  const [numberToRelease, setNumberToRelease] =
    useState<PhoneNumberResponse | null>(null);
  const [search, setSearch] = useState('');
  const [assignedToFilter, setAssignedToFilter] = useState<
    AssignedToFilter | 'all'
  >('all');
  const [typeFilter, setTypeFilter] = useState<PhoneNumberType | 'all'>('all');
  const [notice, setNotice] = useState<Notice | null>(() =>
    noticeFromLink(searchParams.get('released')),
  );

  // Read once into the notice; a reload or Back must not raise it again.
  useEffect(() => {
    if (searchParams.get('released')) {
      router.replace('/admin/phone-numbers');
    }
  }, [searchParams, router]);

  const {
    phoneNumbers,
    page,
    totalPages,
    isLoading,
    error: loadError,
    setQuery,
    refetch,
  } = usePhoneNumbers();

  const {
    purchase,
    importNumber,
    update,
    release,
    isLoading: isMutating,
    error: mutationError,
    clearError,
  } = usePhoneNumberMutations();

  const filters = useMemo(
    () => ({
      search: search || undefined,
      assignedTo: assignedToFilter === 'all' ? undefined : assignedToFilter,
      type: typeFilter === 'all' ? undefined : typeFilter,
    }),
    [search, assignedToFilter, typeFilter],
  );

  useEffect(() => {
    setQuery({ ...filters, page: 1 });
  }, [filters, setQuery]);

  const isFiltered = Object.values(filters).some(
    (value) => value !== undefined,
  );

  // Read on its own, not from the page, which after a refused move may no
  // longer list it: the dialog shows, and the move is checked against, the
  // holder it has now.
  const {
    phoneNumber: movingNow,
    error: movingError,
    refetch: refetchMoving,
  } = usePhoneNumber(moveRequest?.phoneNumber.id ?? null);
  const movingNumber = moveRequest
    ? movingNow?.id === moveRequest.phoneNumber.id
      ? movingNow
      : moveRequest.phoneNumber
    : null;
  const movingGone =
    movingError instanceof ApiError && movingError.status === 404;

  // Released or removed by somebody else since the list was loaded: there is
  // nothing left to move.
  useEffect(() => {
    if (!movingGone) return;

    setMoveRequest(null);
    setNotice({ message: 'That number is no longer on the list.' });
    refetch();
  }, [movingGone, refetch]);

  const handlePurchase = async (data: PurchasePhoneNumber) => {
    setNotice(null);

    try {
      const bought = await purchase(data);
      const message = purchaseNotice(bought);

      if (message) {
        setNotice({ message, phoneNumberId: bought.id });
      }
    } finally {
      // A purchase that failed after Twilio sold the number may still list it.
      await refetch();
    }
  };

  const handleImport = async (data: ImportPhoneNumber) => {
    setNotice(null);

    try {
      const imported = await importNumber(data);
      const message = importNotice(imported);

      if (message) {
        setNotice({ message, phoneNumberId: imported.id });
      }
    } finally {
      // An import that failed after recording the number still lists it.
      await refetch();
    }
  };

  const handleMove = async (owner: PhoneNumberOwner | null) => {
    if (!movingNumber) return;

    try {
      await update(movingNumber.id, {
        owner,
        expectedOwner: ownerOf(movingNumber.assignedTo),
      });
      setMoveRequest(null);
    } catch {
      // The mutation hook keeps the error, and the dialog shows it.
      await refetchMoving();
    } finally {
      await refetch();
    }
  };

  const handleRelease = async () => {
    if (!numberToRelease) return;

    try {
      const released = await release(numberToRelease.id);
      const message = releaseNotice(released, numberToRelease.provider);

      setNumberToRelease(null);
      setNotice(message ? { message } : null);
    } catch {
      // The mutation hook keeps the error, and the dialog shows it.
    } finally {
      await refetch();
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Phone Numbers</h1>
          <p className="text-muted-foreground">
            Buy new numbers or add the ones you already own, and assign each to
            a team member or a department
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <Download className="mr-2 h-4 w-4" />
            Add a number you own
          </Button>
          <Button onClick={() => setIsPurchaseOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Buy a number
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:flex-1 sm:min-w-[200px] sm:max-w-sm">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by number, label or holder..."
          />
        </div>
        <Select
          value={assignedToFilter}
          onValueChange={(value) =>
            setAssignedToFilter(value as AssignedToFilter | 'all')
          }
        >
          <SelectTrigger
            className="w-[calc(50%-0.375rem)] sm:w-[170px]"
            aria-label="Assigned to"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Anyone or nobody</SelectItem>
            <SelectItem value="user">Users</SelectItem>
            <SelectItem value="department">Departments</SelectItem>
            <SelectItem value="nobody">In reserve</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={typeFilter}
          onValueChange={(value) =>
            setTypeFilter(value as PhoneNumberType | 'all')
          }
        >
          <SelectTrigger
            className="w-[calc(50%-0.375rem)] sm:w-[150px]"
            aria-label="Type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="LOCAL">Local</SelectItem>
            <SelectItem value="TOLL_FREE">Toll-free</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {notice && (
        <div className="p-3 text-sm rounded-md bg-muted" role="status">
          {notice.message}
          {notice.phoneNumberId && (
            <>
              {' '}
              <Link
                href={`/admin/phone-numbers/${notice.phoneNumberId}`}
                className="font-medium underline"
              >
                Open the number
              </Link>
            </>
          )}
        </div>
      )}

      {loadError && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
          Could not load phone numbers: {loadError.message}
        </div>
      )}

      {!isLoading && !loadError && phoneNumbers.length === 0 ? (
        <div className="border rounded-lg p-8 text-center space-y-3">
          {isFiltered ? (
            <p className="text-muted-foreground">
              No numbers match these filters.
            </p>
          ) : (
            <>
              <p className="font-medium">No phone numbers yet</p>
              <p className="text-sm text-muted-foreground">
                Buy a number from Twilio, or add one your Twilio account already
                holds, then give it to a user or a department.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={() => setIsImportOpen(true)}>
                  <Download className="mr-2 h-4 w-4" />
                  Add a number you own
                </Button>
                <Button onClick={() => setIsPurchaseOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Buy a number
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <PhoneNumberTable
          phoneNumbers={phoneNumbers}
          isLoading={isLoading}
          onMove={(phoneNumber) => {
            clearError();
            setMoveRequest({ phoneNumber, toReserve: false });
          }}
          onMoveToReserve={(phoneNumber) => {
            clearError();
            setMoveRequest({ phoneNumber, toReserve: true });
          }}
          onRelease={(phoneNumber) => {
            clearError();
            setNumberToRelease(phoneNumber);
          }}
        />
      )}

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={(newPage) => setQuery({ ...filters, page: newPage })}
        />
      )}

      <PurchaseNumberDialog
        open={isPurchaseOpen}
        onOpenChange={setIsPurchaseOpen}
        onPurchase={handlePurchase}
        isLoading={isMutating}
      />

      <ImportNumberDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        onImport={handleImport}
        isLoading={isMutating}
      />

      <MoveNumberDialog
        phoneNumber={movingNumber}
        toReserve={moveRequest?.toReserve}
        onClose={() => setMoveRequest(null)}
        onConfirm={handleMove}
        isLoading={isMutating}
        error={mutationError?.message ?? null}
      />

      <ReleaseNumberDialog
        phoneNumber={numberToRelease}
        onClose={() => setNumberToRelease(null)}
        onConfirm={handleRelease}
        isLoading={isMutating}
        error={mutationError?.message ?? null}
      />
    </div>
  );
}
