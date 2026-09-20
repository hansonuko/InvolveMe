import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/session';

// docs/14-ADMIN-DASHBOARD-SCOPING.md §7.2: every protected route checks a
// real session before anything else runs. This is the coarse gate (valid
// session or not); per-action permission checks (fn_admin_check_permission)
// happen inside each Server Action, since "logged in" and "allowed to do
// this specific thing" are different questions.
export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
