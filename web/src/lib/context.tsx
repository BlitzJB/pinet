import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PiNetConnection } from "./pinet";
import { useStore } from "./store";
import type { SessionState } from "./pinet";

const PiNetContext = createContext<PiNetConnection | null>(null);

export function PiNetProvider({ children }: { children: ReactNode }) {
  const [connection] = useState(() => new PiNetConnection());

  useEffect(() => {
    void connection.connect().catch(() => {
      /* surfaced via connection state */
    });
  }, [connection]);

  return <PiNetContext.Provider value={connection}>{children}</PiNetContext.Provider>;
}

export function usePiNet(): PiNetConnection {
  const connection = useContext(PiNetContext);
  if (!connection) throw new Error("usePiNet must be used inside <PiNetProvider>");
  return connection;
}

export function useConnectionState() {
  return useStore(usePiNet().conn);
}

export function useSessionState(sessionId: string): SessionState {
  return useStore(usePiNet().store(sessionId));
}
