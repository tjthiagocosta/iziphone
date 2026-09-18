'use client';

import type { SetPasswordLink } from '@repo/dto';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  accessTokenFromSearch,
  passwordProblem,
  SET_PASSWORD_CHECKING,
  SET_PASSWORD_NO_TOKEN,
  setPasswordCopy,
} from '@/lib/access-link';
import { describeAccessLink, setPassword } from '@/lib/api/auth';

/**
 * Where an invite and a reset both land. The link in the URL is the whole
 * credential, so the page asks the API whether it is still good before showing
 * a form, and setting the password signs the browser in.
 */
export default function SetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [link, setLink] = useState<SetPasswordLink | null>(null);
  const [password, setPasswordValue] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // After hydration, like the login page: `useSearchParams` would bail the
  // whole page out of static rendering.
  useEffect(() => {
    const found = accessTokenFromSearch(window.location.search);
    setToken(found);

    if (!found) {
      setLink({ valid: false, purpose: null, message: SET_PASSWORD_NO_TOKEN });
      return;
    }

    let current = true;

    describeAccessLink(found)
      .then((described) => {
        if (current) {
          setLink(described);
        }
      })
      .catch(() => {
        if (current) {
          setLink({
            valid: false,
            purpose: null,
            message:
              'We could not check this link. Try again in a moment, or ask an administrator for a new one.',
          });
        }
      });

    return () => {
      current = false;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const problem = passwordProblem(password, confirmation);
    if (problem || !token) {
      setError(problem ?? SET_PASSWORD_NO_TOKEN);
      return;
    }

    setError('');
    setIsSaving(true);

    try {
      await setPassword(token, password);
      // The answer carried the session cookie, so this lands in the app.
      router.push('/');
      router.refresh();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'We could not set your password. Try again in a moment.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const copy = link?.purpose ? setPasswordCopy(link.purpose) : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">
            {copy?.heading ?? 'Set your password'}
          </CardTitle>
          {copy && (
            <CardDescription className="text-center">
              {copy.intro}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {link === null && (
            <p role="status" className="text-sm text-muted-foreground">
              {SET_PASSWORD_CHECKING}
            </p>
          )}

          {link && !link.valid && (
            <p
              role="status"
              className="p-3 text-sm text-amber-700 bg-amber-50 rounded-md dark:bg-amber-900/20 dark:text-amber-400"
            >
              {link.message}
            </p>
          )}

          {link?.valid && copy && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">
                  New password
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPasswordValue(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="confirmation" className="text-sm font-medium">
                  Repeat password
                </label>
                <Input
                  id="confirmation"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isSaving}>
                {isSaving ? 'Saving...' : copy.submitLabel}
              </Button>
            </form>
          )}
        </CardContent>
        <CardFooter className="justify-center">
          <p className="text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
