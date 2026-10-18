import type { Metadata } from "next";
import { RecordScreen } from "@/features/recorder/record-screen";

export const metadata: Metadata = { title: "New recording · Stepwise" };

export default function RecordPage() {
  return <RecordScreen />;
}
