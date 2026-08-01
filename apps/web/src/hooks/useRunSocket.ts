import { useEffect, useRef, useState } from "react";
import type { WsEvent } from "@ops-master/shared";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10_000;

/** Broadcasts every pipeline event to every connected client (see ws/hub.ts) — the server
 * assumes clients reconnect on their own; it does not replay missed events. Reconnects with
 * capped exponential backoff on any drop (dev-server restart, laptop sleep, network blip) so a
 * client doesn't silently stop receiving events for the rest of the session. `connected`
 * transitioning back to true (including the very first connect) is the caller's signal to
 * refetch REST state in case events were missed while disconnected. */
export function useRunSocket(onEvent: (event: WsEvent) => void): { connected: boolean } {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data?.type && data.type !== "connected") cbRef.current(data as WsEvent);
        } catch {
          // ignore malformed frames
        }
      };
      const scheduleReconnect = () => {
        if (cancelled || reconnectTimer) return;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
        attempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };
      ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { connected };
}
