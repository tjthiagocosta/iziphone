/*
 * Which paths need a signed-in user, and how the browser finds out whether
 * one is present. Shared by the edge proxy, which checks the cookie, and the
 * auth provider, which learns from the API that the cookie no longer opens a
 * session.
 */

/** Paths a signed-out visitor may open. */
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password'];

/*
 * Suffixes of files the app serves from its own origin. Only a last segment
 * ending in one of these is a file: a dot anywhere in the path is not enough,
 * or `/app/conversations/a.b` would leave a signed-out visitor looking at the
 * signed-in shell with every request behind it refused.
 */
const STATIC_FILE_EXTENSIONS = new Set([
  'avif',
  'css',
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'js',
  'json',
  'map',
  'mp3',
  'mp4',
  'pdf',
  'png',
  'svg',
  'txt',
  'wav',
  'webmanifest',
  'webp',
  'woff',
  'woff2',
  'xml',
]);

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

function isStaticFile(pathname: string): boolean {
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = segment.lastIndexOf('.');
  // A leading dot names a hidden file, not an extension.
  if (dot <= 0) {
    return false;
  }
  return STATIC_FILE_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase());
}

/** Whether a path is behind the session guard. */
export function requiresSession(pathname: string): boolean {
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return false;
  }

  // The API routes carry their own auth, and static assets have none.
  return !(
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    isStaticFile(pathname)
  );
}

/** Where to send a visitor so they come back to `pathname` after signing in. */
export function loginPathFor(pathname: string): string {
  return `/login?redirect=${encodeURIComponent(pathname)}`;
}

/*
 * A path the browser resolves against its own origin, used to tell a local
 * path from one that leaves the site. The URL parser reads a backslash as a
 * slash under an http scheme, so `/\evil.example` and `/\/evil.example` name
 * another host just as `//evil.example` does: only the resolved origin
 * settles it.
 */
const LOCAL_ORIGIN = 'http://localhost';

/**
 * The path the login page may send a visitor back to. Only a local path is
 * accepted, so a crafted link cannot bounce the user to another site.
 */
export function safeRedirectTarget(redirect: string | null): string {
  if (!redirect?.startsWith('/')) {
    return '/';
  }

  let resolved: URL;
  try {
    resolved = new URL(redirect, LOCAL_ORIGIN);
  } catch {
    return '/';
  }

  if (resolved.origin !== LOCAL_ORIGIN) {
    return '/';
  }

  // The resolved parts, not the original text: `//localhost/app` stays on
  // this origin but must not keep its authority when it is handed to the
  // router.
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
