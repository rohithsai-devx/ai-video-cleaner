import type { Metadata } from "next";
import { RunScreen } from "@/features/runs/run-screen";

export const metadata: Metadata = { title: "Progress · Stepwise" };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunScreen id={id} />;
}
