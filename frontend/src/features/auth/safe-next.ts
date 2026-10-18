const BASE = "http://stepwise.invalid";

/**
 * Only same-origin paths are allowed as a post-sign-in destination. The value is parsed the way the
 * browser will parse it (which strips tabs and newlines, so "/\t/evil.example" is protocol-relative),
 * and anything that resolves to another origin falls back to /library.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/library";
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/library";
  }
  if (url.origin !== BASE) return "/library";
  return `${url.pathname}${url.search}${url.hash}`;
}
