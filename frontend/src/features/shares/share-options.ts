export type Visibility = "private" | "workspace" | "link";
export type Expiry = "never" | "7d" | "30d";

// The public share page resolves only `link` shares today (app.resolve_share), so the private and
// workspace options stay hidden until the backend serves them; offering them would mint links that 404.
export const VISIBILITY_OPTIONS: { id: Visibility; label: string; hint: string }[] = [
  { id: "link", label: "Anyone with the link", hint: "No sign-in needed. Good for customers." },
];

export const EXPIRY_OPTIONS: { id: Expiry; label: string }[] = [
  { id: "never", label: "Never" },
  { id: "7d", label: "In 7 days" },
  { id: "30d", label: "In 30 days" },
];

export function absoluteShareUrl(url: string, origin: string): string {
  return new URL(url, origin).toString();
}

export function expiryToIso(expiry: Expiry, now: Date = new Date()): string | null {
  if (expiry === "never") return null;
  const days = expiry === "7d" ? 7 : 30;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
