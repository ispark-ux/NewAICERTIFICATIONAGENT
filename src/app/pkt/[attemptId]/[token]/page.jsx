"use client";

import { useParams } from "next/navigation";
import ProctoredTest from "@/components/pkt/ProctoredTest";

/** Agent-side (work from home): personal, token-protected test link. */
export default function SharedPktPage() {
  const { attemptId, token } = useParams();
  return <ProctoredTest attemptId={attemptId} token={token} />;
}
