import type { Metadata } from "next";
import { LibraryScreen } from "@/features/videos/library-screen";

export const metadata: Metadata = { title: "Library · Stepwise" };

export default function LibraryPage() {
  return <LibraryScreen />;
}
