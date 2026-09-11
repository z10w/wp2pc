import { DurableObject } from "cloudflare:workers";

export interface Env {
  PAIR_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type Role = "pc" | "phone";

type Attachment = {
  role: Role;
  room: string;
  mode: "pair" | "reconnect";
  deviceId?: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "device-bridge",
        websocket: `${url.origin.replace("https:", "wss:").replace("http:", "ws:")}/ws`,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname !== "/ws") {
      return env.ASSETS.fetch(request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const room = url.searchParams.get("room")?.trim();
    if (!room || room.length < 8 || room.length > 96) {
      return new Response("Invalid room", { status: 400 });
    }

    const role = url.searchParams.get("role");
    if (role !== "pc" && role !== "phone") {
      return new Response("Invalid role", { status: 400 });
    }

    const mode = url.searchParams.get("mode") === "pair" ? "pair" : "reconnect";
    const id = env.PAIR_ROOMS.idFromName(room);
    const stub = env.PAIR_ROOMS.get(id);
    return stub.fetch(new Request(request, {
      headers: new Headers(request.headers),
    }));
  },
};

export class PairRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role") as Role | null;
    const room = url.searchParams.get("room") ?? "";
    const mode = url.searchParams.get("mode") === "pair" ? "pair" : "reconnect";

    if (role !== "pc" && role !== "phone") {
      return new Response("Invalid role", { status: 400 });
    }

    const sockets = this.ctx.getWebSockets();
    const existingSameRole = sockets.find((ws) => {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      return attachment?.role === role;
    });
    if (existingSameRole) {
      return new Response("Role already connected", { status: 409 });
    }
    if (sockets.length >= 2) {
      return new Response("Room is full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, room, mode } satisfies Attachment);

    if (mode === "pair" && sockets.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    }

    server.send(JSON.stringify({ t: "server_ready", role }));

    const all = this.ctx.getWebSockets();
    if (all.length === 2) {
      for (const ws of all) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "peer_connected", role }));
        }
      }
    } else {
      server.send(JSON.stringify({ t: "peer_waiting", role }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const peer = sockets.find((candidate) => candidate !== ws);
    if (!peer || peer.readyState !== WebSocket.OPEN) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "peer_not_connected" }));
      }
      return;
    }

    try {
      peer.send(message);
    } catch {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "relay_error" }));
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ t: "peer_disconnected", code, reason }));
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ t: "peer_error" }));
      }
    }
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "Pairing window expired");
      } catch {
        // Ignore already-closed sockets.
      }
    }
  }
}
