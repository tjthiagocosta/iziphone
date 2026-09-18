'use client';

import {
  RECORDING_RETENTION_OPTIONS,
  type RecordingRetention,
  type RecordingRetentionPolicy,
  retentionPolicyLabel,
} from '@repo/dto';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface RecordingRetentionFormProps {
  retention: RecordingRetention;
  isSaving: boolean;
  onSave: (retention: RecordingRetention) => void;
}

/**
 * How long recordings are kept. Both policies are saved together: the sweep
 * reads one decision, and the audit entry records one change.
 */
export function RecordingRetentionForm({
  retention,
  isSaving,
  onSave,
}: RecordingRetentionFormProps) {
  const [draft, setDraft] = useState(retention);

  // A save answers with what was stored, and a reload with what is stored.
  useEffect(() => setDraft(retention), [retention]);

  const changed =
    draft.voicemail !== retention.voicemail ||
    draft.callRecordings !== retention.callRecordings;

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <PolicyField
        id="voicemail-retention"
        label="Voicemails"
        description="How long a voicemail a caller left is kept."
        value={draft.voicemail}
        onChange={(voicemail) => setDraft({ ...draft, voicemail })}
      />

      <PolicyField
        id="call-recording-retention"
        label="Call recordings"
        description="How long the recording of a call itself is kept."
        value={draft.callRecordings}
        onChange={(callRecordings) => setDraft({ ...draft, callRecordings })}
      />

      <p className="text-sm text-muted-foreground">
        A recording past its policy is deleted by the hourly sweep: the audio is
        gone for good, and the call keeps saying there was a recording and that
        the retention policy deleted it. Shortening a policy deletes everything
        already older than it.
      </p>

      <Button type="submit" disabled={!changed || isSaving}>
        {isSaving ? 'Saving…' : 'Save retention policy'}
      </Button>
    </form>
  );
}

interface PolicyFieldProps {
  id: string;
  label: string;
  description: string;
  value: RecordingRetentionPolicy;
  onChange: (policy: RecordingRetentionPolicy) => void;
}

function PolicyField({
  id,
  label,
  description,
  value,
  onChange,
}: PolicyFieldProps) {
  return (
    <div className="space-y-2 max-w-sm">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as RecordingRetentionPolicy)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={retentionPolicyLabel(value)} />
        </SelectTrigger>
        <SelectContent>
          {RECORDING_RETENTION_OPTIONS.map((option) => (
            <SelectItem key={option.policy} value={option.policy}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
