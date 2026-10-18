import { signOut } from "@/lib/server/auth-exchange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Response {
  return signOut(req);
}
