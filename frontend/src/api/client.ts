import createFetchClient from "openapi-fetch";
import createClient from "openapi-react-query";
import { QueryClient } from "@tanstack/react-query";
import type { paths } from "./generated/schema";

export const fetchClient = createFetchClient<paths>({ baseUrl: "/api" });

// An expired or missing session: go to sign-in and come back afterwards. The sign-in and sign-up
// calls answer 401 for a wrong password, which the form shows itself, so they are left alone.
fetchClient.use({
  onResponse({ request, response }) {
    if (response.status !== 401 || typeof window === "undefined") return;
    if (new URL(request.url, window.location.origin).pathname.startsWith("/api/auth/")) return;
    const here = `${window.location.pathname}${window.location.search}`;
    // A full page load on purpose: it drops every cached query from the expired session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/sign-in?next=${encodeURIComponent(here)}`);
  },
});
export const $api = createClient(fetchClient);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
  });
}
