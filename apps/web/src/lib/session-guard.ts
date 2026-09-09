/*
 * Which paths need a signed-in user, and how the browser finds out whether
 * one is present. Shared by the edge proxy, which checks the cookie, and the
 * auth provider, which learns from the API that the cookie no longer opens a
 * session.
 */

/** Paths a signed-out visitor may open. */
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password'];

/*
 * Better Auth names the session cookie after the `iziphone` prefix the API
 * configures, and prefixes it with `__Secure-` when the API runs with secure
 * cookies. The guard has to recognize both, or every page redirects to the
 * login screen in production.
 */
export const SESSION_COOKIE_NAMES = [
  'iziphone.session_token',
  '__Secure-iziphone.session_token',
];

/** Whether a path is behind the session guard. */
export function requiresSession(pathname: string): boolean {
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return false;
  }

  // The API routes carry their own auth, and static assets have none.
  return !(
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  );
}

/** Where to send a visitor so they come back to `pathname` after signing in. */
export function loginPathFor(pathname: string): string {
  return `/login?redirect=${encodeURIComponent(pathname)}`;
}

/**
 * The path the login page may send a visitor back to. Only a local path is
 * accepted, so a crafted link cannot bounce the user to another site.
 */
export function safeRedirectTarget(redirect: string | null): string {
  return redirect?.startsWith('/') && !redirect.startsWith('//')
    ? redirect
    : '/';
}
