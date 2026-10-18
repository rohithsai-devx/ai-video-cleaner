import "server-only";

// CSRF guard: state-changing requests must carry an Origin equal to the app's own origin.
// Browsers always send Origin on non-GET fetches and form posts, so a missing one is refused.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function first(value: string | null): string | null {
  return value ? (value.split(",")[0]?.trim() ?? null) : null;
}

export function appOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = first(req.headers.get("x-forwarded-host")) ?? req.headers.get("host") ?? url.host;
  const proto = first(req.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`.toLowerCase();
}

export function isAllowedOrigin(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  return origin.toLowerCase() === appOrigin(req);
}
