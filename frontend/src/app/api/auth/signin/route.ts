import { exchangeCredentials } from "@/lib/server/auth-exchange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return exchangeCredentials(req, "/auth/signin");
}
