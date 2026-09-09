import { type NextRequest, NextResponse } from 'next/server';

/** Paths a signed-out visitor may open. */
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password'];

/*
 * Better Auth names the session cookie after the `iziphone` prefix the API
 * configures, and prefixes it with `__Secure-` when the API runs with secure
 * cookies. The guard has to recognize both, or every page redirects to the
 * login screen in production.
 */
const SESSION_COOKIE_NAMES = [
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

/** Where to send a visitor after signing in. */
export function loginPathFor(pathname: string): string {
  return `/login?redirect=${encodeURIComponent(pathname)}`;
}

/**
 * Route guard. It only checks that a session cookie is present; the API
 * validates the session itself on every request.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!requiresSession(pathname)) {
    return NextResponse.next();
  }

  const signedIn = SESSION_COOKIE_NAMES.some((name) =>
    request.cookies.has(name),
  );
  if (signedIn) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL(loginPathFor(pathname), request.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
