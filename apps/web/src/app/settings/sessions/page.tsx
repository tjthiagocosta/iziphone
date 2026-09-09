'use client';

import type { UserSession } from '@repo/dto';
import { LogOut, Monitor, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from '@/lib/api/auth';

function describeClient(userAgent: string | null): {
  browser: string;
  device: string;
} {
  if (!userAgent) {
    return { browser: 'Unknown', device: 'Unknown device' };
  }

  let browser = 'Unknown';
  if (userAgent.includes('Edg')) browser = 'Edge';
  else if (userAgent.includes('Chrome')) browser = 'Chrome';
  else if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Safari')) browser = 'Safari';

  let device = 'Desktop';
  if (userAgent.includes('Mobile')) device = 'Mobile';
  else if (userAgent.includes('Tablet')) device = 'Tablet';

  return { browser, device };
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function SessionsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      setSessions(await listSessions());
    } catch (loadError) {
      setError(messageOf(loadError, 'Failed to load sessions'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      void loadSessions();
    }
  }, [user, loadSessions]);

  const handleRevoke = async (sessionId: string) => {
    try {
      await revokeSession(sessionId);
      setSessions((current) =>
        current.filter((session) => session.id !== sessionId),
      );
    } catch (revokeError) {
      setError(messageOf(revokeError, 'Failed to revoke the session'));
    }
  };

  const handleRevokeOthers = async () => {
    try {
      await revokeOtherSessions();
      await loadSessions();
    } catch (revokeError) {
      setError(messageOf(revokeError, 'Failed to revoke the other sessions'));
    }
  };

  if (authLoading) {
    return (
      <div className="container mx-auto py-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="container mx-auto py-8">
        <p className="text-muted-foreground">
          Please sign in to view sessions.
        </p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Active Sessions</CardTitle>
          <CardDescription>
            Manage your active sessions across devices. You can sign out from
            other devices if you notice any suspicious activity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          )}

          {sessions.length > 1 && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void handleRevokeOthers()}
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign out from all other devices
            </Button>
          )}

          {isLoading ? (
            <p className="text-muted-foreground text-center py-4">
              Loading sessions...
            </p>
          ) : sessions.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              No active sessions found.
            </p>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => {
                const { browser, device } = describeClient(session.userAgent);
                const DeviceIcon = device === 'Mobile' ? Smartphone : Monitor;

                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="flex items-center gap-4">
                      <DeviceIcon className="w-8 h-8 text-muted-foreground" />
                      <div>
                        <p className="font-medium">
                          {browser} on {device}
                          {session.isCurrent && (
                            <span className="ml-2 text-xs text-green-600 dark:text-green-400">
                              (Current)
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {session.ipAddress || 'Unknown IP'} &bull; Signed in{' '}
                          {formatDate(session.createdAt)}
                        </p>
                      </div>
                    </div>
                    {!session.isCurrent && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleRevoke(session.id)}
                        title="Revoke session"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
