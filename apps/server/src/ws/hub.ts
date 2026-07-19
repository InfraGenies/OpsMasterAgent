import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { WsEvent } from "@ops-master/shared";

let wss: WebSocketServer | undefined;

/** One small demo app, one shared feed — every event is broadcast to every connected client and the UI filters by request_id client-side. */
export function initWsHub(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });
}

export function broadcast(event: WsEvent): void {
  if (!wss) return;
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function now(): string {
  return new Date().toISOString();
}

export function broadcastEvent(
  type: WsEvent["type"],
  requestId: string,
  node?: WsEvent["node"],
  payload?: unknown
): void {
  broadcast({ type, request_id: requestId, node, ts: now(), payload });
}
