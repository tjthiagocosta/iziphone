'use client';

import type { PhoneNumberConnection, PhoneNumberOwner } from '@repo/dto';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { CapabilityBadges } from '@/components/admin/phone-numbers/CapabilityBadges';
import { MoveNumberDialog } from '@/components/admin/phone-numbers/MoveNumberDialog';
import { ReleaseNumberDialog } from '@/components/admin/phone-numbers/ReleaseNumberDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  usePhoneNumber,
  usePhoneNumberConnection,
  usePhoneNumberMutations,
} from '@/hooks/use-admin-phone-numbers';
import { formatPhoneNumber } from '@/lib/phone-number';
import {
  NUMBER_TYPE_LABELS,
  reconnectReasonText,
  textingNoteText,
} from '@/lib/phone-numbers/number-terms';
import { ownerOf } from '@/lib/phone-numbers/owner-selection';

type OpenDialog = 'move' | 'reserve' | 'release' | null;

export default function PhoneNumberDetailPage() {
  const params = useParams();
  const router = useRouter();
  const phoneNumberId = params.id as string;

  const {
    phoneNumber,
    isLoading,
    error: loadError,
    refetch,
  } = usePhoneNumber(phoneNumberId);
  const {
    connection,
    isLoading: isCheckingConnection,
    error: connectionError,
    refetch: recheckConnection,
  } = usePhoneNumberConnection(phoneNumberId);
  const {
    update,
    reconnect,
    release,
    isLoading: isMutating,
    error: mutationError,
    clearError,
  } = usePhoneNumberMutations();

  const [label, setLabel] = useState('');
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Follows the stored label, not every reload, so text being typed survives
  // a change made elsewhere on the page.
  const storedLabel = phoneNumber?.label ?? '';
  useEffect(() => {
    setLabel(storedLabel);
  }, [storedLabel]);

  /** The holder on screen: a move decided on it is refused once somebody else moved the number. */
  const shownOwner = phoneNumber ? ownerOf(phoneNumber.assignedTo) : undefined;

  const openOne = (dialog: OpenDialog) => {
    clearError();
    setNotice(null);
    setOpenDialog(dialog);
  };

  // A refusal belongs to the dialog that met it, not to the page behind it.
  const closeDialog = () => {
    clearError();
    setOpenDialog(null);
  };

  /** Runs a change, then reloads the number; a failure stays in `mutationError`. */
  const apply = async (change: () => Promise<unknown>, done: string) => {
    setNotice(null);

    try {
      await change();
      setOpenDialog(null);
      setNotice(done);
    } catch {
      // The mutation hook keeps the error, and the page or dialog shows it.
    } finally {
      await refetch();
    }
  };

  const handleSaveLabel = () =>
    apply(
      () => update(phoneNumberId, { label: label.trim() || null }),
      'Label saved.',
    );

  const handlePrimary = (isPrimary: boolean) =>
    apply(
      () => update(phoneNumberId, { isPrimary, expectedOwner: shownOwner }),
      isPrimary ? 'Now the primary number.' : 'No longer the primary number.',
    );

  const handleMove = (owner: PhoneNumberOwner | null) =>
    apply(
      () => update(phoneNumberId, { owner, expectedOwner: shownOwner }),
      owner ? 'Number assigned.' : 'Number moved to the reserve.',
    );

  const handleReconnect = async () => {
    // The check that follows says what Twilio does with the number now,
    // texts included, which a messaging service may still keep.
    await apply(
      () => reconnect(phoneNumberId),
      'Reconnected: the number’s webhooks point here again.',
    );
    await recheckConnection();
  };

  const handleRelease = async () => {
    try {
      const released = await release(phoneNumberId);
      router.push(
        released.cancelledAtTwilio
          ? '/admin/phone-numbers'
          : `/admin/phone-numbers?released=${phoneNumber?.provider ?? 'TWILIO'}`,
      );
    } catch {
      // The mutation hook keeps the error, and the dialog shows it.
      await refetch();
    }
  };

  if (isLoading && !phoneNumber) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!phoneNumber) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" asChild>
          <Link href="/admin/phone-numbers">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Phone Numbers
          </Link>
        </Button>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            {loadError ? loadError.message : 'Phone number not found'}
          </p>
        </div>
      </div>
    );
  }

  const holder = phoneNumber.assignedTo;
  const labelChanged = label.trim() !== (phoneNumber.label ?? '');
  const pageError = openDialog === null ? mutationError : null;
  // A release that stopped half-way: only releasing again changes it.
  const releaseUnfinished = phoneNumber.status === 'RELEASED';
  const frozen = isMutating || releaseUnfinished;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/phone-numbers" aria-label="Back to Phone Numbers">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold font-mono">
            {formatPhoneNumber(phoneNumber.phoneNumber)}
          </h1>
          <p className="text-muted-foreground truncate">
            {phoneNumber.label ?? 'No label'}
          </p>
        </div>
      </div>

      {pageError && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
          {pageError.message}
        </div>
      )}
      {releaseUnfinished && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
          A release of this number did not finish, so Twilio may still have it
          and bill for it. Choose Finish release below; nothing else can change
          the number until then.
        </div>
      )}
      {notice && !pageError && (
        <div className="p-3 text-sm rounded-md bg-muted" role="status">
          {notice}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Assigned to</CardTitle>
              <CardDescription>
                Who answers this number and texts from it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {holder ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={
                      holder.type === 'user'
                        ? `/admin/users/${holder.id}`
                        : `/admin/departments/${holder.id}`
                    }
                    className="font-medium hover:underline"
                  >
                    {holder.name}
                  </Link>
                  <Badge
                    variant={
                      holder.type === 'department' ? 'default' : 'secondary'
                    }
                  >
                    {holder.type === 'department' ? 'Department' : 'User'}
                  </Badge>
                </div>
              ) : releaseUnfinished ? (
                <Badge variant="destructive">Release unfinished</Badge>
              ) : (
                <div className="space-y-1">
                  <Badge variant="outline">In reserve</Badge>
                  <p className="text-sm text-muted-foreground">
                    Nobody answers it, and it still costs its monthly fee.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => openOne('move')}
                  disabled={frozen}
                >
                  {holder ? 'Move to...' : 'Assign to...'}
                </Button>
                {holder && (
                  <Button
                    variant="outline"
                    onClick={() => openOne('reserve')}
                    disabled={isMutating}
                  >
                    Move to reserve
                  </Button>
                )}
              </div>

              {holder?.type === 'department' && (
                <>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor="detail-is-primary" className="font-normal">
                      Primary number
                      <span className="block text-xs text-muted-foreground">
                        The line the department’s members call and text from
                        first.
                      </span>
                    </Label>
                    <Switch
                      id="detail-is-primary"
                      checked={phoneNumber.isPrimary}
                      onCheckedChange={handlePrimary}
                      disabled={frozen}
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Label</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveLabel();
                }}
              >
                <Input
                  id="label"
                  aria-label="Label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Main sales line"
                  maxLength={50}
                  disabled={releaseUnfinished}
                />
                <Button
                  type="submit"
                  disabled={!labelChanged || frozen}
                  className="sm:w-auto"
                >
                  Save
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <DetailRow label="Number">
                <span className="font-mono">{phoneNumber.phoneNumber}</span>
              </DetailRow>
              <DetailRow label="Type">
                <Badge variant="outline">
                  {NUMBER_TYPE_LABELS[phoneNumber.type]}
                </Badge>
              </DetailRow>
              {(phoneNumber.locality || phoneNumber.region) && (
                <DetailRow label="Location">
                  {[
                    phoneNumber.locality,
                    phoneNumber.region,
                    phoneNumber.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </DetailRow>
              )}
              <DetailRow label="Provider">
                <Badge variant="outline">{phoneNumber.provider}</Badge>
              </DetailRow>
              <Separator />
              <DetailRow label="Capabilities">
                <CapabilityBadges
                  voice={phoneNumber.voiceEnabled}
                  sms={phoneNumber.smsEnabled}
                  mms={phoneNumber.mmsEnabled}
                  fax={phoneNumber.faxEnabled}
                  className="justify-end"
                />
              </DetailRow>
              <Separator />
              <DetailRow label="Added">
                {new Date(phoneNumber.createdAt).toLocaleDateString()}
              </DetailRow>
              <DetailRow label="Updated">
                {new Date(phoneNumber.updatedAt).toLocaleDateString()}
              </DetailRow>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connection</CardTitle>
              <CardDescription>
                Reconnect tells Twilio to send this number’s calls and texts to
                this deployment, and detaches a TwiML App, application or SIP
                trunk that would take them instead. Use it when a purchase or an
                import could not finish setting the number up, after the
                deployment moved to a new address, or after somebody changed the
                number in the Twilio Console. It does not change messaging
                services.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!releaseUnfinished && (
                <ConnectionStatus
                  connection={connection}
                  isChecking={isCheckingConnection}
                  error={connectionError}
                />
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void handleReconnect()}
                  disabled={frozen || connection?.state === 'not-in-account'}
                >
                  Reconnect
                </Button>
                {!releaseUnfinished && (
                  <Button
                    variant="ghost"
                    onClick={() => void recheckConnection()}
                    disabled={isCheckingConnection}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Check again
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Release</CardTitle>
              <CardDescription>
                {holder
                  ? 'Only a number in the reserve can be released. Move it to the reserve first.'
                  : releaseUnfinished
                    ? 'Asks Twilio again to take the number back, then takes it off the list.'
                    : 'Gives the number back to Twilio, which stops charging for it.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="destructive"
                onClick={() => openOne('release')}
                disabled={isMutating || holder !== null}
              >
                {releaseUnfinished ? 'Finish release' : 'Release number'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <MoveNumberDialog
        phoneNumber={
          openDialog === 'move' || openDialog === 'reserve' ? phoneNumber : null
        }
        toReserve={openDialog === 'reserve'}
        onClose={closeDialog}
        onConfirm={(owner) => void handleMove(owner)}
        isLoading={isMutating}
        error={mutationError?.message ?? null}
      />

      <ReleaseNumberDialog
        phoneNumber={openDialog === 'release' ? phoneNumber : null}
        onClose={closeDialog}
        onConfirm={() => void handleRelease()}
        isLoading={isMutating}
        error={mutationError?.message ?? null}
      />
    </div>
  );
}

/** What Twilio does with the number's calls and texts now, as last checked. */
function ConnectionStatus({
  connection,
  isChecking,
  error,
}: {
  connection: PhoneNumberConnection | null;
  isChecking: boolean;
  error: Error | null;
}) {
  if (isChecking && !connection) {
    return (
      <p className="flex items-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Checking with Twilio...
      </p>
    );
  }

  if (error || !connection) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not check with Twilio
        {error ? `: ${error.message}` : '.'}
      </p>
    );
  }

  if (connection.state === 'not-in-account') {
    return (
      <div className="space-y-1">
        <Badge variant="destructive">Not on the Twilio account</Badge>
        <p className="text-sm text-muted-foreground">
          This Twilio account does not hold the number, so its calls and texts
          do not come through it, and Reconnect cannot point it here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2" role="status">
      {connection.needsReconnect.length === 0 ? (
        <div className="space-y-1">
          <Badge variant="secondary">Connected</Badge>
          <p className="text-sm text-muted-foreground">
            Twilio sends this number’s calls and texts here.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <Badge variant="destructive">Needs Reconnect</Badge>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {connection.needsReconnect.map((reason) => (
              <li key={reason}>{reconnectReasonText(reason)}</li>
            ))}
          </ul>
        </div>
      )}
      {connection.texting && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {textingNoteText(connection.texting)}
        </p>
      )}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
