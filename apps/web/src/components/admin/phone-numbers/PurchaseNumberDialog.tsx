'use client';

import type {
  AvailablePhoneNumber,
  PhoneNumberType,
  PurchasePhoneNumber,
} from '@repo/dto';
import { ArrowLeft, Check, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAvailableNumbers } from '@/hooks/use-admin-phone-numbers';
import { getDepartments, getUsers } from '@/lib/api/admin';
import { cn } from '@/lib/utils';

type Step = 'search' | 'select' | 'configure';

interface PurchaseNumberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPurchase: (data: PurchasePhoneNumber) => Promise<void>;
  isLoading?: boolean;
}

export function PurchaseNumberDialog({
  open,
  onOpenChange,
  onPurchase,
  isLoading = false,
}: PurchaseNumberDialogProps) {
  const [step, setStep] = useState<Step>('search');

  // Search form
  const [searchType, setSearchType] = useState<PhoneNumberType>('LOCAL');
  const [areaCode, setAreaCode] = useState('');
  const [contains, setContains] = useState('');
  const [searchErrors, setSearchErrors] = useState<Record<string, string>>({});

  // Selection
  const [selectedNumber, setSelectedNumber] =
    useState<AvailablePhoneNumber | null>(null);

  // Configure form
  const [label, setLabel] = useState('');
  const [assignmentType, setAssignmentType] = useState<
    'none' | 'user' | 'department'
  >('none');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedUserName, setSelectedUserName] = useState('');
  const [selectedDepartmentId, setSelectedDepartmentId] = useState('');
  const [selectedDepartmentName, setSelectedDepartmentName] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  const {
    numbers,
    isLoading: isSearching,
    error: searchError,
    search,
    reset: resetSearch,
  } = useAvailableNumbers();

  // Reset all state when dialog closes
  useEffect(() => {
    if (!open) {
      setStep('search');
      setSearchType('LOCAL');
      setAreaCode('');
      setContains('');
      setSearchErrors({});
      setSelectedNumber(null);
      setLabel('');
      setAssignmentType('none');
      setSelectedUserId('');
      setSelectedUserName('');
      setSelectedDepartmentId('');
      setSelectedDepartmentName('');
      setIsPrimary(false);
      resetSearch();
    }
  }, [open, resetSearch]);

  const handleSearch = async () => {
    const errors: Record<string, string> = {};
    if (searchType === 'LOCAL' && areaCode && !/^\d{3}$/.test(areaCode)) {
      errors.areaCode = 'Area code must be 3 digits';
    }
    setSearchErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSelectedNumber(null);
    await search({
      country: 'US',
      type: searchType,
      areaCode: searchType === 'LOCAL' && areaCode ? areaCode : undefined,
      contains: contains || undefined,
      limit: 20,
    });
    setStep('select');
  };

  const handlePurchase = async () => {
    if (!selectedNumber) return;

    const data: PurchasePhoneNumber = {
      phoneNumber: selectedNumber.phoneNumber,
      country: 'US',
      type: selectedNumber.type,
      label: label || undefined,
      userId: assignmentType === 'user' ? selectedUserId : undefined,
      departmentId:
        assignmentType === 'department' ? selectedDepartmentId : undefined,
      isPrimary: assignmentType === 'department' ? isPrimary : false,
    };

    await onPurchase(data);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        {step === 'search' && (
          <SearchStep
            type={searchType}
            onTypeChange={setSearchType}
            areaCode={areaCode}
            onAreaCodeChange={setAreaCode}
            contains={contains}
            onContainsChange={setContains}
            errors={searchErrors}
            isLoading={isSearching}
            onSearch={handleSearch}
            onCancel={() => onOpenChange(false)}
          />
        )}

        {step === 'select' && (
          <SelectStep
            numbers={numbers}
            selected={selectedNumber}
            onSelect={setSelectedNumber}
            isLoading={isSearching}
            error={searchError}
            onBack={() => setStep('search')}
            onContinue={() => setStep('configure')}
          />
        )}

        {step === 'configure' && selectedNumber && (
          <ConfigureStep
            selectedNumber={selectedNumber}
            label={label}
            onLabelChange={setLabel}
            assignmentType={assignmentType}
            onAssignmentTypeChange={(type) => {
              setAssignmentType(type);
              setSelectedUserId('');
              setSelectedUserName('');
              setSelectedDepartmentId('');
              setSelectedDepartmentName('');
              setIsPrimary(false);
            }}
            selectedUserId={selectedUserId}
            selectedUserName={selectedUserName}
            onUserSelect={(id, name) => {
              setSelectedUserId(id);
              setSelectedUserName(name);
            }}
            selectedDepartmentId={selectedDepartmentId}
            selectedDepartmentName={selectedDepartmentName}
            onDepartmentSelect={(id, name) => {
              setSelectedDepartmentId(id);
              setSelectedDepartmentName(name);
            }}
            isPrimary={isPrimary}
            onIsPrimaryChange={setIsPrimary}
            isLoading={isLoading}
            onBack={() => setStep('select')}
            onPurchase={handlePurchase}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================
// Step 1: Search
// ============================================

function SearchStep({
  type,
  onTypeChange,
  areaCode,
  onAreaCodeChange,
  contains,
  onContainsChange,
  errors,
  isLoading,
  onSearch,
  onCancel,
}: {
  type: PhoneNumberType;
  onTypeChange: (type: PhoneNumberType) => void;
  areaCode: string;
  onAreaCodeChange: (value: string) => void;
  contains: string;
  onContainsChange: (value: string) => void;
  errors: Record<string, string>;
  isLoading: boolean;
  onSearch: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Purchase Phone Number</DialogTitle>
        <DialogDescription>
          Search for available numbers from Twilio
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label>Number Type</Label>
          <Select
            value={type}
            onValueChange={(value: PhoneNumberType) => onTypeChange(value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LOCAL">Local</SelectItem>
              <SelectItem value="TOLL_FREE">Toll-Free</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {type === 'LOCAL' && (
          <div className="space-y-2">
            <Label>Area Code (optional)</Label>
            <Input
              value={areaCode}
              onChange={(e) =>
                onAreaCodeChange(e.target.value.replace(/\D/g, '').slice(0, 3))
              }
              placeholder="e.g. 512"
              maxLength={3}
            />
            {errors.areaCode && (
              <p className="text-sm text-destructive">{errors.areaCode}</p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label>Contains (optional)</Label>
          <Input
            value={contains}
            onChange={(e) => onContainsChange(e.target.value)}
            placeholder="e.g. 555"
          />
        </div>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button onClick={onSearch} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          Search Numbers
        </Button>
      </DialogFooter>
    </>
  );
}

// ============================================
// Step 2: Select
// ============================================

function SelectStep({
  numbers,
  selected,
  onSelect,
  isLoading,
  error,
  onBack,
  onContinue,
}: {
  numbers: AvailablePhoneNumber[];
  selected: AvailablePhoneNumber | null;
  onSelect: (number: AvailablePhoneNumber) => void;
  isLoading: boolean;
  error: Error | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Select a Number</DialogTitle>
        <DialogDescription>
          {numbers.length > 0
            ? `${numbers.length} number${numbers.length === 1 ? '' : 's'} found`
            : 'Choose from available numbers'}
        </DialogDescription>
      </DialogHeader>

      <div className="py-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => `search-skeleton-${i}`).map(
              (key) => (
                <div
                  key={key}
                  className="flex items-center gap-3 p-3 border rounded-md"
                >
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-36 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  </div>
                  <div className="flex gap-1">
                    <div className="h-5 w-10 bg-muted animate-pulse rounded" />
                    <div className="h-5 w-10 bg-muted animate-pulse rounded" />
                  </div>
                </div>
              ),
            )}
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-destructive">{error.message}</p>
            <p className="text-sm text-muted-foreground mt-1">
              Try adjusting your search criteria
            </p>
          </div>
        ) : numbers.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground">No numbers found</p>
            <p className="text-sm text-muted-foreground mt-1">
              Try a different area code or search pattern
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-[360px]">
            <div className="space-y-2 pr-4">
              {numbers.map((number) => (
                <button
                  key={number.phoneNumber}
                  type="button"
                  className={cn(
                    'flex items-center gap-3 w-full p-3 border rounded-md text-left transition-colors',
                    selected?.phoneNumber === number.phoneNumber
                      ? 'border-primary bg-accent'
                      : 'hover:bg-muted/50',
                  )}
                  onClick={() => onSelect(number)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-mono font-medium">
                      {number.friendlyName}
                    </p>
                    {(number.locality || number.region) && (
                      <p className="text-sm text-muted-foreground">
                        {[number.locality, number.region]
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {number.capabilities.sms && (
                      <Badge variant="secondary" className="text-xs">
                        SMS
                      </Badge>
                    )}
                    {number.capabilities.mms && (
                      <Badge variant="secondary" className="text-xs">
                        MMS
                      </Badge>
                    )}
                    {number.capabilities.voice && (
                      <Badge variant="secondary" className="text-xs">
                        Voice
                      </Badge>
                    )}
                    {selected?.phoneNumber === number.phoneNumber && (
                      <Check className="h-4 w-4 text-primary ml-1" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={onContinue} disabled={!selected}>
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}

// ============================================
// Step 3: Configure & Purchase
// ============================================

function ConfigureStep({
  selectedNumber,
  label,
  onLabelChange,
  assignmentType,
  onAssignmentTypeChange,
  selectedUserId,
  selectedUserName,
  onUserSelect,
  selectedDepartmentId,
  selectedDepartmentName,
  onDepartmentSelect,
  isPrimary,
  onIsPrimaryChange,
  isLoading,
  onBack,
  onPurchase,
}: {
  selectedNumber: AvailablePhoneNumber;
  label: string;
  onLabelChange: (value: string) => void;
  assignmentType: 'none' | 'user' | 'department';
  onAssignmentTypeChange: (type: 'none' | 'user' | 'department') => void;
  selectedUserId: string;
  selectedUserName: string;
  onUserSelect: (id: string, name: string) => void;
  selectedDepartmentId: string;
  selectedDepartmentName: string;
  onDepartmentSelect: (id: string, name: string) => void;
  isPrimary: boolean;
  onIsPrimaryChange: (value: boolean) => void;
  isLoading: boolean;
  onBack: () => void;
  onPurchase: () => void;
}) {
  const canPurchase =
    assignmentType === 'none' ||
    (assignmentType === 'user' && selectedUserId) ||
    (assignmentType === 'department' && selectedDepartmentId);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Configure & Purchase</DialogTitle>
        <DialogDescription>
          Review your selection and configure assignment
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        {/* Selected number summary */}
        <div className="p-3 border rounded-md bg-muted/50">
          <p className="font-mono font-medium">{selectedNumber.friendlyName}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-muted-foreground">
              {selectedNumber.phoneNumber}
            </span>
            {(selectedNumber.locality || selectedNumber.region) && (
              <span className="text-sm text-muted-foreground">
                &middot;{' '}
                {[selectedNumber.locality, selectedNumber.region]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            )}
          </div>
          <div className="flex gap-1 mt-2">
            {selectedNumber.capabilities.sms && (
              <Badge variant="secondary" className="text-xs">
                SMS
              </Badge>
            )}
            {selectedNumber.capabilities.mms && (
              <Badge variant="secondary" className="text-xs">
                MMS
              </Badge>
            )}
            {selectedNumber.capabilities.voice && (
              <Badge variant="secondary" className="text-xs">
                Voice
              </Badge>
            )}
          </div>
        </div>

        {/* Label */}
        <div className="space-y-2">
          <Label>Label (optional)</Label>
          <Input
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="e.g. Main Sales Line"
            maxLength={50}
          />
        </div>

        {/* Assignment */}
        <div className="space-y-3">
          <Label>Assign to</Label>
          <RadioGroup
            value={assignmentType}
            onValueChange={(value) =>
              onAssignmentTypeChange(value as 'none' | 'user' | 'department')
            }
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="none" id="assign-none" />
              <Label htmlFor="assign-none" className="font-normal">
                No assignment (Reserved)
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="user" id="assign-user" />
              <Label htmlFor="assign-user" className="font-normal">
                Assign to user
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="department" id="assign-department" />
              <Label htmlFor="assign-department" className="font-normal">
                Assign to department
              </Label>
            </div>
          </RadioGroup>

          {assignmentType === 'user' && (
            <UserPicker
              selectedId={selectedUserId}
              selectedName={selectedUserName}
              onSelect={onUserSelect}
            />
          )}

          {assignmentType === 'department' && (
            <div className="space-y-3">
              <DepartmentPicker
                selectedId={selectedDepartmentId}
                selectedName={selectedDepartmentName}
                onSelect={onDepartmentSelect}
              />
              {selectedDepartmentId && (
                <div className="flex items-center justify-between">
                  <Label htmlFor="is-primary" className="font-normal">
                    Set as primary number
                  </Label>
                  <Switch
                    id="is-primary"
                    checked={isPrimary}
                    onCheckedChange={onIsPrimaryChange}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={isLoading}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={onPurchase} disabled={isLoading || !canPurchase}>
          {isLoading ? 'Purchasing...' : 'Purchase Number'}
        </Button>
      </DialogFooter>
    </>
  );
}

// ============================================
// Assignment pickers (Popover + Command pattern)
// ============================================

function UserPicker({
  selectedId,
  selectedName,
  onSelect,
}: {
  selectedId: string;
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

function DepartmentPicker({
  selectedId,
  selectedName,
  onSelect,
}: {
  selectedId: string;
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
