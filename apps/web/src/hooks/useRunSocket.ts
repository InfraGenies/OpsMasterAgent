import { useEffect, useRef, useState } from "react";
import type { WsEvent } from "@ops-master/shared";

export function useRunSocket(onEvent: (event: WsEvent) => void): { connected: boolean } {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data?.type && data.type !== "connected") cbRef.current(data as WsEvent);
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, []);

  return { connected };
}
