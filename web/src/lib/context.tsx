import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PinetConnection } from "./pinet";
import { useStore } from "./store";
import type { SessionState } from "./pinet";

const PinetContext = createContext<PinetConnection | null>(null);

export function PinetProvider({ children }: { children: ReactNode }) {
  const [connection] = useState(() => new PinetConnection());

  useEffect(() => {
    void connection.connect().catch(() => {
      /* surfaced via connection state */
    });
  }, [connection]);

  return <PinetContext.Provider value={connection}>{children}</PinetContext.Provider>;
}

export function usePinet(): PinetConnection {
  const connection = useContext(PinetContext);
  if (!connection) throw new Error("usePinet must be used inside <PinetProvider>");
  return connection;
}

export function useConnectionState() {
  return useStore(usePinet().conn);
}

export function useSessionState(sessionId: string): SessionState {
  return useStore(usePinet().store(sessionId));
}
