'use client';

import type { RecordingRetention } from '@repo/dto';
import { DefaultMessagingServiceForm } from '@/components/admin/settings/DefaultMessagingServiceForm';
import { RecordingRetentionForm } from '@/components/admin/settings/RecordingRetentionForm';
import { useMessagingServices } from '@/hooks/use-messaging-services';
import { useSystemSettings } from '@/hooks/use-system-settings';

export default function SettingsPage() {
  const { settings, isLoading, isSaving, error, saveRecordingRetention } =
    useSystemSettings();
  const messaging = useMessagingServices(true);

  const handleSave = (retention: RecordingRetention) => {
    void saveRecordingRetention(retention);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          How this deployment keeps what it records and registers its texts
        </p>
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Recording retention</h2>
          <p className="text-sm text-muted-foreground">
            {settings?.updatedAt
              ? `Last changed ${new Date(settings.updatedAt).toLocaleString()}`
              : 'Never changed; recordings are kept until somebody deletes them.'}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}

        {isLoading || !settings ? (
          <p className="text-sm text-muted-foreground">Loading settings…</p>
        ) : (
          <RecordingRetentionForm
            retention={settings.recordingRetention}
            isSaving={isSaving}
            onSave={handleSave}
          />
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Texting</h2>
          <p className="text-sm text-muted-foreground">
            The A2P 10DLC campaign a new local number texts through, as its
            messaging service on your Twilio account.
          </p>
        </div>

        <DefaultMessagingServiceForm
          services={messaging.data}
          isLoading={messaging.isLoading}
          error={messaging.error}
          isSaving={messaging.isSaving}
          saveError={messaging.saveError}
          onRetry={() => void messaging.refetch()}
          onSave={(sid) => void messaging.saveDefault(sid)}
        />
      </section>
    </div>
  );
}
