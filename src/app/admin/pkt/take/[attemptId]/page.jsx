"use client";

import { useParams } from "next/navigation";
import ProctoredTest from "@/components/pkt/ProctoredTest";

/** Trainer-side: run the proctored PKT on this computer. */
export default function TakePktPage() {
  const { attemptId } = useParams();
  return <ProctoredTest attemptId={attemptId} />;
}
