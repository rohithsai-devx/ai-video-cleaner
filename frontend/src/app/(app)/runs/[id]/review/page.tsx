import type { Metadata } from "next";
import { ReviewScreen } from "@/features/review/review-screen";

export const metadata: Metadata = { title: "Review · Stepwise" };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewScreen id={id} />;
}
