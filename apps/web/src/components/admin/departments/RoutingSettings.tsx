'use client';

import type {
  DepartmentAgentResponse,
  DepartmentSettingsResponse,
  UpdateDepartmentSettings,
} from '@repo/dto';
import { getTimeZones } from '@vvo/tzdb';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { AgentOrderDialog } from './AgentOrderDialog';
import { VoicemailGreetingField } from './VoicemailGreetingField';

interface RoutingSettingsProps {
  settings: DepartmentSettingsResponse;
  agents: DepartmentAgentResponse[];
  onSave: (data: UpdateDepartmentSettings) => Promise<void>;
  onReorderAgents: (data: {
    agentOrder: Array<{ userId: string; order: number }>;
  }) => Promise<void>;
  /** The greeting is stored as soon as it is chosen; it is not part of Save. */
  onUploadGreeting: (file: File) => Promise<void>;
  onRemoveGreeting: () => Promise<void>;
  isLoading?: boolean;
}

/** What Save may send: the response also carries the id and the greeting URL, which are not settings. */
function editableSettings({
  timezone,
  is24Hours,
  openHoursRoutingType,
  closedHoursRoutingType,
  closedHoursExternalNumber,
  ringDuration,
}: DepartmentSettingsResponse): UpdateDepartmentSettings {
  return {
    timezone,
    is24Hours,
    openHoursRoutingType,
    closedHoursRoutingType,
    closedHoursExternalNumber,
    ringDuration,
  };
}

export function RoutingSettings({
  settings,
  agents,
  onSave,
  onReorderAgents,
  onUploadGreeting,
  onRemoveGreeting,
  isLoading = false,
}: RoutingSettingsProps) {
  const [localSettings, setLocalSettings] = useState(() =>
    editableSettings(settings),
  );
  const [hasChanges, setHasChanges] = useState(false);
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);

  const timezones = getTimeZones();

  const updateSetting = <K extends keyof UpdateDepartmentSettings>(
    key: K,
    value: UpdateDepartmentSettings[K],
  ) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    await onSave(localSettings);
    setHasChanges(false);
  };

  return (
    <div className="space-y-6">
      {/* Timezone */}
      <div className="space-y-2">
        <Label>Timezone</Label>
        <Select
          value={localSettings.timezone}
          onValueChange={(value) => updateSetting('timezone', value)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-[300px]">
            {timezones.map((tz) => (
              <SelectItem key={tz.name} value={tz.name}>
                {tz.name} ({tz.abbreviation})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 24/7 Toggle */}
      <div className="flex items-center justify-between p-3 rounded-md border">
        <div>
          <Label>24/7 Operations</Label>
          <p className="text-sm text-muted-foreground">
            Ignore business hours, always route calls
          </p>
        </div>
        <Switch
          checked={localSettings.is24Hours}
          onCheckedChange={(checked) => updateSetting('is24Hours', checked)}
        />
      </div>

      {/* Open Hours Routing */}
      <div className="space-y-3">
        <Label>Open Hours Routing</Label>
        <RadioGroup
          value={localSettings.openHoursRoutingType}
          onValueChange={(value) =>
            updateSetting(
              'openHoursRoutingType',
              value as 'SIMULTANEOUS' | 'FIXED_ORDER',
            )
          }
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="SIMULTANEOUS" id="simultaneous" />
            <Label htmlFor="simultaneous" className="font-normal">
              Ring all agents simultaneously
            </Label>
          </div>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="FIXED_ORDER" id="fixed" />
              <Label htmlFor="fixed" className="font-normal">
                Ring agents in order
              </Label>
            </div>
            {localSettings.openHoursRoutingType === 'FIXED_ORDER' && (
              <div className="ml-6">
                <p className="text-sm text-muted-foreground mb-2">
                  Agents are rung based on the same fixed order.
                </p>
                <Button
                  variant="link"
                  className="h-auto p-0 text-primary"
                  onClick={() => setOrderDialogOpen(true)}
                >
                  View and edit order
                </Button>
              </div>
            )}
          </div>
        </RadioGroup>
      </div>

      {/* Ring Duration */}
      <div className="space-y-3">
        <div className="flex justify-between">
          <Label>Ring Duration</Label>
          <span className="text-sm text-muted-foreground">
            {localSettings.ringDuration} seconds
          </span>
        </div>
        <Slider
          value={[localSettings.ringDuration || 30]}
          onValueChange={([value]) => updateSetting('ringDuration', value)}
          min={10}
          max={45}
          step={5}
        />
        <p className="text-xs text-muted-foreground">
          How long to ring before going to voicemail or next routing option
        </p>
      </div>

      {/* Closed Hours Routing */}
      <div className="space-y-3">
        <Label>Closed Hours Routing</Label>
        <RadioGroup
          value={localSettings.closedHoursRoutingType}
          onValueChange={(value) =>
            updateSetting(
              'closedHoursRoutingType',
              value as 'VOICEMAIL' | 'EXTERNAL_NUMBER',
            )
          }
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="VOICEMAIL" id="voicemail" />
            <Label htmlFor="voicemail" className="font-normal">
              Send to voicemail
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="EXTERNAL_NUMBER" id="external" />
            <Label htmlFor="external" className="font-normal">
              Forward to external number
            </Label>
          </div>
        </RadioGroup>

        {localSettings.closedHoursRoutingType === 'EXTERNAL_NUMBER' && (
          <Input
            value={localSettings.closedHoursExternalNumber || ''}
            onChange={(e) =>
              updateSetting('closedHoursExternalNumber', e.target.value)
            }
            placeholder="+1234567890"
            className="mt-2"
          />
        )}
      </div>

      <VoicemailGreetingField
        greetingUrl={settings.voicemailGreetingUrl}
        onUpload={onUploadGreeting}
        onRemove={onRemoveGreeting}
        isLoading={isLoading}
      />

      <Button
        onClick={handleSave}
        disabled={!hasChanges || isLoading}
        className="w-full"
      >
        {isLoading ? 'Saving...' : 'Save Settings'}
      </Button>

      {/* Agent Order Dialog */}
      <AgentOrderDialog
        open={orderDialogOpen}
        onOpenChange={setOrderDialogOpen}
        agents={agents}
        onSave={onReorderAgents}
        isLoading={isLoading}
      />
    </div>
  );
}
