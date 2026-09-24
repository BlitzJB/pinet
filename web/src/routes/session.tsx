import { useParams } from "@tanstack/react-router";
import { ThreadView } from "../components/thread/ThreadView";

export function SessionPage() {
  const { sessionId } = useParams({ from: "/s/$sessionId" });
  return <ThreadView sessionId={sessionId} />;
}
