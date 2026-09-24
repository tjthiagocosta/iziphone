'use client';

import type { UpdatePhoneNumber } from '@repo/dto';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  usePhoneNumber,
  usePhoneNumberMutations,
} from '@/hooks/use-admin-phone-numbers';
import { getDepartments, getUsers } from '@/lib/api/admin';

export default function PhoneNumberDetailPage() {
  const params = useParams();
  const router = useRouter();
  const phoneNumberId = params.id as string;

  const { phoneNumber, isLoading, refetch } = usePhoneNumber(phoneNumberId);
  const {
    update,
    release,
    isLoading: isMutating,
    error: mutationError,
  } = usePhoneNumberMutations();

  const [label, setLabel] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);
  // The hook's error is shown next to the button that caused it: the page
  // scrolls, and a reason at its top can be out of sight of either button.
  const [failedAction, setFailedAction] = useState<'save' | 'release' | null>(
    null,
  );

  // Assignment state
  const [assignmentType, setAssignmentType] = useState<
    'none' | 'user' | 'department'
  >('none');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserName, setSelectedUserName] = useState('');
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<
    string | null
  >(null);
  const [selectedDepartmentName, setSelectedDepartmentName] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  // Sync form state from fetched data
  useEffect(() => {
    if (phoneNumber) {
      setLabel(phoneNumber.label || '');
      setIsPrimary(phoneNumber.isPrimary);
      if (phoneNumber.assignedTo) {
        setAssignmentType(phoneNumber.assignedTo.type);
        if (phoneNumber.assignedTo.type === 'user') {
          setSelectedUserId(phoneNumber.assignedTo.id);
          setSelectedUserName(phoneNumber.assignedTo.name);
          setSelectedDepartmentId(null);
          setSelectedDepartmentName('');
        } else {
          setSelectedDepartmentId(phoneNumber.assignedTo.id);
          setSelectedDepartmentName(phoneNumber.assignedTo.name);
          setSelectedUserId(null);
          setSelectedUserName('');
        }
      } else {
        setAssignmentType('none');
        setSelectedUserId(null);
        setSelectedUserName('');
        setSelectedDepartmentId(null);
        setSelectedDepartmentName('');
      }
      setHasChanges(false);
    }
  }, [phoneNumber]);

  const handleSave = async () => {
    if (!phoneNumber) return;

    const updates: UpdatePhoneNumber = {};
    const currentLabel = phoneNumber.label || '';
    if (label !== currentLabel) updates.label = label || null;

    // Assignment changes
    if (assignmentType === 'none') {
      if (phoneNumber.assignedTo) {
        // Clear all assignment fields so the backend marks the number reserved.
        updates.userId = null;
        updates.departmentId = null;
        updates.isPrimary = false;
      }
    } else if (assignmentType === 'user') {
      if (
        phoneNumber.assignedTo?.type !== 'user' ||
        phoneNumber.assignedTo?.id !== selectedUserId
      ) {
        updates.userId = selectedUserId;
        updates.departmentId = null;
        updates.isPrimary = false;
      }
    } else if (assignmentType === 'department') {
      if (
        phoneNumber.assignedTo?.type !== 'department' ||
        phoneNumber.assignedTo?.id !== selectedDepartmentId
      ) {
        updates.departmentId = selectedDepartmentId;
        updates.userId = null;
      }
      if (isPrimary !== phoneNumber.isPrimary) {
        updates.isPrimary = isPrimary;
      }
    }

    if (Object.keys(updates).length === 0) return;

    try {
      await update(phoneNumberId, updates);
      setHasChanges(false);
      refetch();
    } catch {
      setFailedAction('save');
    }
  };

  const handleRelease = async () => {
    try {
      await release(phoneNumberId);
      router.push('/admin/phone-numbers');
    } catch {
      // The hook keeps the reason; the dialog would cover it.
      setShowReleaseConfirm(false);
      setFailedAction('release');
    }
  };

  if (isLoading) {
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
          <p className="text-muted-foreground">Phone number not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/phone-numbers">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">
            {phoneNumber.friendlyName || phoneNumber.phoneNumber}
          </h1>
          <p className="text-muted-foreground">Edit phone number details</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Details (read-only) */}
        <Card>
          <CardHeader>
            <CardTitle>Phone Number Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Number</span>
              <span className="font-mono">{phoneNumber.phoneNumber}</span>
            </div>
            {phoneNumber.friendlyName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Friendly Name</span>
                <span>{phoneNumber.friendlyName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline">{phoneNumber.type}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge
                variant={
                  phoneNumber.status === 'ACTIVE' ? 'default' : 'secondary'
                }
              >
                {phoneNumber.status}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Provider</span>
              <Badge variant="outline">{phoneNumber.provider}</Badge>
            </div>
            {(phoneNumber.locality || phoneNumber.region) && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Location</span>
                <span>
                  {[
                    phoneNumber.locality,
                    phoneNumber.region,
                    phoneNumber.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </div>
            )}
            <Separator />
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Capabilities</span>
              <div className="flex gap-1">
                {phoneNumber.smsEnabled && (
                  <Badge variant="secondary" className="text-xs">
                    SMS
                  </Badge>
                )}
                {phoneNumber.mmsEnabled && (
                  <Badge variant="secondary" className="text-xs">
                    MMS
                  </Badge>
                )}
                {phoneNumber.voiceEnabled && (
                  <Badge variant="secondary" className="text-xs">
                    Voice
                  </Badge>
                )}
                {phoneNumber.faxEnabled && (
                  <Badge variant="secondary" className="text-xs">
                    Fax
                  </Badge>
                )}
              </div>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>
                {new Date(phoneNumber.createdAt).toLocaleDateString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Updated</span>
              <span>
                {new Date(phoneNumber.updatedAt).toLocaleDateString()}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Configuration (editable) */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="label">Label</Label>
                <Input
                  id="label"
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    setHasChanges(true);
                  }}
                  placeholder="e.g. Main Sales Line"
                  maxLength={50}
                />
              </div>

              <Separator />

              <div className="space-y-3">
                <Label>Assignment</Label>

                <div className="space-y-2">
                  <button
                    type="button"
                    className={`w-full text-left p-2 rounded-md border transition-colors ${assignmentType === 'none' ? 'border-primary bg-accent' : 'hover:bg-muted/50'}`}
                    onClick={() => {
                      setAssignmentType('none');
                      setHasChanges(true);
                    }}
                  >
                    <span className="text-sm">Unassigned (Reserved)</span>
                  </button>

                  <button
                    type="button"
                    className={`w-full text-left p-2 rounded-md border transition-colors ${assignmentType === 'user' ? 'border-primary bg-accent' : 'hover:bg-muted/50'}`}
                    onClick={() => {
                      setAssignmentType('user');
                      if (!selectedUserId) {
                        setSelectedDepartmentId(null);
                        setSelectedDepartmentName('');
                      }
                      setHasChanges(true);
                    }}
                  >
                    <span className="text-sm">Assign to user</span>
                  </button>

                  {assignmentType === 'user' && (
                    <div className="pl-4">
                      <AssignmentUserPicker
                        selectedId={selectedUserId}
                        selectedName={selectedUserName}
                        onSelect={(id, name) => {
                          setSelectedUserId(id);
                          setSelectedUserName(name);
                          setHasChanges(true);
                        }}
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    className={`w-full text-left p-2 rounded-md border transition-colors ${assignmentType === 'department' ? 'border-primary bg-accent' : 'hover:bg-muted/50'}`}
                    onClick={() => {
                      setAssignmentType('department');
                      if (!selectedDepartmentId) {
                        setSelectedUserId(null);
                        setSelectedUserName('');
                      }
                      setHasChanges(true);
                    }}
                  >
                    <span className="text-sm">Assign to department</span>
                  </button>

                  {assignmentType === 'department' && (
                    <div className="pl-4 space-y-3">
                      <AssignmentDepartmentPicker
                        selectedId={selectedDepartmentId}
                        selectedName={selectedDepartmentName}
                        onSelect={(id, name) => {
                          setSelectedDepartmentId(id);
                          setSelectedDepartmentName(name);
                          setHasChanges(true);
                        }}
                      />
                      {selectedDepartmentId && (
                        <div className="flex items-center justify-between">
                          <Label
                            htmlFor="detail-is-primary"
                            className="font-normal"
                          >
                            Primary number
                          </Label>
                          <Switch
                            id="detail-is-primary"
                            checked={isPrimary}
                            onCheckedChange={(checked) => {
                              setIsPrimary(checked);
                              setHasChanges(true);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <Button
                onClick={handleSave}
                disabled={!hasChanges || isMutating}
                className="w-full"
              >
                {isMutating ? 'Saving...' : 'Save Changes'}
              </Button>
              {mutationError && failedAction === 'save' && (
                <p role="alert" className="text-sm text-destructive">
                  {mutationError.message}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Danger Zone */}
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Danger Zone</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Releasing this number will cancel it with Twilio. This action
                cannot be undone.
              </p>
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => setShowReleaseConfirm(true)}
              >
                Release Number
              </Button>
              {mutationError && failedAction === 'release' && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {mutationError.message}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={showReleaseConfirm}
        onOpenChange={setShowReleaseConfirm}
        title="Release Phone Number"
        description={`Are you sure you want to release ${phoneNumber.phoneNumber}? This will remove the number from Twilio and it cannot be recovered.`}
        confirmLabel="Release"
        variant="destructive"
        onConfirm={handleRelease}
        isLoading={isMutating}
      />
    </div>
  );
}

// ============================================
// Assignment pickers (same Popover+Command pattern)
// ============================================

function AssignmentUserPicker({
  selectedId,
  selectedName,
  onSelect,
}: {
  selectedId: string | null;
  selectedName: string;
  onSelect: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<
    { id: string; name: string; email: string }[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);

  const searchUsers = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const result = await getUsers({ search: query || undefined, limit: 20 });
      setUsers(
        result.users.map((u) => ({
          id: u.id,
          name: u.name || '',
          email: u.email,
        })),
      );
    } catch {
      // Silently fail
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      searchUsers(searchQuery);
    }
  }, [open, searchQuery, searchUsers]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-start font-normal">
          {selectedId ? selectedName : 'Select a user...'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search users..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            {isSearching ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (
              <>
                <CommandEmpty>No users found.</CommandEmpty>
                <CommandGroup>
                  {users.map((user) => (
                    <CommandItem
                      key={user.id}
                      value={user.id}
                      onSelect={() => {
                        onSelect(user.id, user.name || user.email);
                        setOpen(false);
                        setSearchQuery('');
                      }}
                    >
                      <div>
                        <p className="font-medium">{user.name || user.email}</p>
                        {user.name && (
                          <p className="text-sm text-muted-foreground">
                            {user.email}
                          </p>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AssignmentDepartmentPicker({
  selectedId,
  selectedName,
  onSelect,
}: {
  selectedId: string | null;
  selectedName: string;
  onSelect: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [departments, setDepartments] = useState<
    { id: string; name: string }[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);

  const searchDepartments = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const result = await getDepartments({
        search: query || undefined,
        limit: 20,
      });
      setDepartments(
        result.departments.map((d) => ({ id: d.id, name: d.name })),
      );
    } catch {
      // Silently fail
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      searchDepartments(searchQuery);
    }
  }, [open, searchQuery, searchDepartments]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-start font-normal">
          {selectedId ? selectedName : 'Select a department...'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search departments..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            {isSearching ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (
              <>
                <CommandEmpty>No departments found.</CommandEmpty>
                <CommandGroup>
                  {departments.map((dept) => (
                    <CommandItem
                      key={dept.id}
                      value={dept.id}
                      onSelect={() => {
                        onSelect(dept.id, dept.name);
                        setOpen(false);
                        setSearchQuery('');
                      }}
                    >
                      <p className="font-medium">{dept.name}</p>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
