import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/server/cookie-name";

// Optimistic gate only: the API still authorizes every request with the token.
const APP_ROUTES = ["/library", "/record", "/videos", "/runs"];
const AUTH_ROUTES = ["/sign-in", "/sign-up"];

function under(pathname: string, roots: string[]): boolean {
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const signedIn = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!signedIn && under(pathname, APP_ROUTES)) {
    const target = new URL("/sign-in", request.url);
    target.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(target);
  }
  if (signedIn && under(pathname, AUTH_ROUTES)) {
    return NextResponse.redirect(new URL("/library", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/library/:path*",
    "/record/:path*",
    "/videos/:path*",
    "/runs/:path*",
    "/sign-in",
    "/sign-up",
  ],
};
