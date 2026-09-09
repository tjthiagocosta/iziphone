import { type NextRequest, NextResponse } from 'next/server';
import {
  loginPathFor,
  requiresSession,
  SESSION_COOKIE_NAMES,
} from './lib/session-guard';

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
