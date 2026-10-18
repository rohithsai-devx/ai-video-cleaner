import { proxyToApi } from "@/lib/server/upstream";

// Node runtime so request bodies and SSE responses stream without buffering.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = proxyToApi;
export const HEAD = proxyToApi;
export const POST = proxyToApi;
export const PUT = proxyToApi;
export const PATCH = proxyToApi;
export const DELETE = proxyToApi;
export const OPTIONS = proxyToApi;
