'use client';

import type { BusinessHoursItem } from '@repo/dto';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const TIMES = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = i % 2 === 0 ? '00' : '30';
  return `${hour.toString().padStart(2, '0')}:${minute}`;
});

interface BusinessHoursEditorProps {
  hours: BusinessHoursItem[];
  onSave: (hours: BusinessHoursItem[]) => Promise<void>;
  isLoading?: boolean;
}

export function BusinessHoursEditor({
  hours,
  onSave,
  isLoading = false,
}: BusinessHoursEditorProps) {
  const [localHours, setLocalHours] = useState<BusinessHoursItem[]>(hours);
  const [hasChanges, setHasChanges] = useState(false);

  const updateDay = (
    dayOfWeek: number,
    updates: Partial<BusinessHoursItem>,
  ) => {
    setLocalHours((prev) =>
      prev.map((h) => (h.dayOfWeek === dayOfWeek ? { ...h, ...updates } : h)),
    );
    setHasChanges(true);
  };

  const handleSave = async () => {
    await onSave(localHours);
    setHasChanges(false);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {localHours.map((hour) => (
          <div
            key={hour.dayOfWeek}
            className="flex items-center gap-4 p-3 rounded-md border"
          >
            <div className="w-24">
              <span className="font-medium">{DAYS[hour.dayOfWeek]}</span>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={hour.isOpen}
                onCheckedChange={(checked) =>
                  updateDay(hour.dayOfWeek, { isOpen: checked })
                }
              />
              <Label className="text-sm">
                {hour.isOpen ? 'Open' : 'Closed'}
              </Label>
            </div>

            {hour.isOpen && (
              <>
                <Select
                  value={hour.openTime || '09:00'}
                  onValueChange={(value) =>
                    updateDay(hour.dayOfWeek, { openTime: value })
                  }
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMES.map((time) => (
                      <SelectItem key={time} value={time}>
                        {time}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <span className="text-muted-foreground">to</span>

                <Select
                  value={hour.closeTime || '17:00'}
                  onValueChange={(value) =>
                    updateDay(hour.dayOfWeek, { closeTime: value })
                  }
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMES.map((time) => (
                      <SelectItem key={time} value={time}>
                        {time}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
        ))}
      </div>

      <Button
        onClick={handleSave}
        disabled={!hasChanges || isLoading}
        className="w-full"
      >
        {isLoading ? 'Saving...' : 'Save Business Hours'}
      </Button>
    </div>
  );
}
