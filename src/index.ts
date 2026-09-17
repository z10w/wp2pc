import { DurableObject } from "cloudflare:workers";

const DEFAULT_ROOM = "24e30495a1ceeed42cdd2def95abcc2e";
const TOKEN_TTL_DAYS_DEFAULT = 365;
const MAX_CHUNK = 8 * 1024 * 1024;   // 8 MiB
const MAX_BACKUPS_LIST = 100;

// ─────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────
type Role = "phone" | "pc";
type TokenRecord = { role: Role; deviceId: string; hash: string; expiresAt: number | null };

type FileMeta = {
  index: number;
  path: string;
  size: number;
  chunks: number;
  sha256: string;
};

type Manifest = {
  version: 3;
  backupId: string;
  roomId: string;
  deviceId: string;
  createdAt: string;
  completedAt?: string;
  totalBytes: number;
  files: FileMeta[];
  encrypted: true;
  encryption: { algorithm: string; keyId: string };
  storageMode: "cloud";
};

interface Env {
  PAIR_ROOMS: DurableObjectNamespace;
  BACKUPS: R2Bucket;
  ASSETS: Fetcher;
}

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function roomFrom(request: Request) {
  return new URL(request.url).searchParams.get("room")?.trim() || DEFAULT_ROOM;
}
function validRoom(room: string) { return /^[A-Za-z0-9._:-]{8,96}$/.test(room); }
function safeId(s: string) { return /^[A-Za-z0-9._:-]{8,120}$/.test(s); }
function token(request: Request) { return request.headers.get("x-bridge-token")?.trim() || ""; }
function hashHex(s: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""));
}
function randomHex(bytes = 32) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
function keyBase(room: string, id: string) { return `backups/${room}/meta/${id}.json`; }
function keyChunk(room: string, id: string, fi: number, ci: number) {
  return `backups/${room}/${id}/f/${fi}/${ci}.bin`;
}

// ─────────────────────────────────────────────────────────
//  Auth (delegates to DO internal /auth endpoint)
// ─────────────────────────────────────────────────────────
async function auth(env: Env, room: string, role: Role, t: string, deviceId?: string) {
  if (!validRoom(room) || !t) return false;
  const stub = env.PAIR_ROOMS.get(env.PAIR_ROOMS.idFromName(room));
  const url = new URL("https://internal/auth");
  url.searchParams.set("role", role);
  const r = await stub.fetch(new Request(url, {
    headers: { "x-bridge-token": t, "x-bridge-device": deviceId || "" },
  }));
  return r.ok;
}

// ─────────────────────────────────────────────────────────
//  Pairing reset (external)
// ─────────────────────────────────────────────────────────
async function resetPairing(request: Request, env: Env, room: string) {
  // Caller must supply a valid token for either role to reset that role,
  // OR supply the reset-secret header if we ever add one.
  // For now: accept valid PC or phone token to reset the whole room.
  const t = token(request);
  const role = (request.headers.get("x-bridge-role") || "pc") as Role;
  if (!validRoom(room)) return json({ ok: false, error: "invalid_room" }, 400);
  if (!t) return json({ ok: false, error: "missing_token" }, 401);
  // Auth against either role
  const authOk = await auth(env, room, role, t);
  if (!authOk) return json({ ok: false, error: "unauthorized" }, 401);
  // Call DO /reset
  const stub = env.PAIR_ROOMS.get(env.PAIR_ROOMS.idFromName(room));
  await stub.fetch(new Request("https://internal/reset", { method: "POST" }));
  return json({ ok: true, message: "pairing_reset" });
}

// ─────────────────────────────────────────────────────────
//  R2 helpers
// ─────────────────────────────────────────────────────────
async function manifest(env: Env, room: string, id: string): Promise<Manifest | null> {
  const o = await env.BACKUPS.get(keyBase(room, id));
  if (!o) return null;
  try { return await o.json<Manifest>(); } catch { return null; }
}

async function initBackup(request: Request, env: Env, room: string) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const deviceId = String(body?.deviceId || "");
  const keyId = String(body?.keyId || "android-keystore-v1");
  if (!(await auth(env, room, "phone", token(request), deviceId)))
    return json({ ok: false, error: "unauthorized" }, 401);
  const id = `b-${Date.now().toString(36)}-${randomHex(8)}`;
  const m: Manifest = {
    version: 3, backupId: id, roomId: room, deviceId,
    createdAt: new Date().toISOString(), totalBytes: 0, files: [],
    encrypted: true,
    encryption: { algorithm: "AES-256-GCM-chunked", keyId },
    storageMode: "cloud",
  };
  await env.BACKUPS.put(keyBase(room, id), JSON.stringify(m));
  return json({ ok: true, backupId: id, maxChunkBytes: MAX_CHUNK });
}

async function putChunk(request: Request, env: Env, room: string, id: string, fi: number, ci: number) {
  if (!safeId(id)) return json({ ok: false, error: "invalid_id" }, 400);
  if (!(await auth(env, room, "phone", token(request)))) return json({ ok: false, error: "unauthorized" }, 401);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_CHUNK) return json({ ok: false, error: "chunk_too_large" }, 413);
  const m = await manifest(env, room, id);
  if (!m) return json({ ok: false, error: "backup_not_found" }, 404);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CHUNK) return json({ ok: false, error: "chunk_too_large" }, 413);
  await env.BACKUPS.put(keyChunk(room, id, fi, ci), body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { backupId: id, fileIndex: String(fi), chunkIndex: String(ci), encrypted: "1" },
  });
  return json({ ok: true });
}

async function complete(request: Request, env: Env, room: string, id: string) {
  if (!safeId(id)) return json({ ok: false, error: "invalid_id" }, 400);
  if (!(await auth(env, room, "phone", token(request)))) return json({ ok: false, error: "unauthorized" }, 401);
  const m = await request.json().catch(() => null) as Manifest | null;
  if (!m || m.backupId !== id) return json({ ok: false, error: "invalid_manifest" }, 400);
  if (!Array.isArray(m.files) || m.files.length > 10000) return json({ ok: false, error: "invalid_files" }, 400);
  for (const f of m.files) {
    if (typeof f.path !== "string" || f.path.length > 1024 || f.path.includes("\\") || f.path.split("/").includes(".."))
      return json({ ok: false, error: "invalid_path" }, 400);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || !Number.isSafeInteger(f.chunks) || f.chunks < 0)
      return json({ ok: false, error: "invalid_file" }, 400);
  }
  m.roomId = room; m.completedAt = new Date().toISOString(); m.encrypted = true; m.storageMode = "cloud";
  await env.BACKUPS.put(keyBase(room, id), JSON.stringify(m));
  return json({ ok: true, backupId: id, completedAt: m.completedAt });
}

async function listBackups(request: Request, env: Env, room: string) {
  const role = (request.headers.get("x-bridge-role") || "pc") as Role;
  if (!(await auth(env, room, role, token(request)))) return json({ ok: false, error: "unauthorized" }, 401);
  const out: Manifest[] = [];
  const listed = await env.BACKUPS.list({ prefix: `backups/${room}/meta/`, limit: MAX_BACKUPS_LIST });
  for (const o of listed.objects) {
    const m = await manifest(env, room, o.key.split("/").pop()!.replace(/\.json$/, ""));
    if (m?.completedAt) out.push(m);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ ok: true, roomId: room, backups: out });
}

async function getManifest(request: Request, env: Env, room: string, id: string) {
  if (!safeId(id)) return json({ ok: false, error: "invalid_id" }, 400);
  const role = (request.headers.get("x-bridge-role") || "pc") as Role;
  if (!(await auth(env, room, role, token(request)))) return json({ ok: false, error: "unauthorized" }, 401);
  const m = await manifest(env, room, id);
  return m ? json({ ok: true, manifest: m }) : json({ ok: false, error: "not_found" }, 404);
}

async function getChunk(request: Request, env: Env, room: string, id: string, fi: number, ci: number) {
  if (!safeId(id)) return json({ ok: false, error: "invalid_id" }, 400);
  const role = (request.headers.get("x-bridge-role") || "pc") as Role;
  if (!(await auth(env, room, role, token(request)))) return json({ ok: false, error: "unauthorized" }, 401);
  const o = await env.BACKUPS.get(keyChunk(room, id, fi, ci));
  if (!o) return json({ ok: false, error: "not_found" }, 404);
  return new Response(o.body, { headers: { "content-type": "application/octet-stream", "cache-control": "private,no-store" } });
}

async function delBackup(request: Request, env: Env, room: string, id: string) {
  if (!safeId(id)) return json({ ok: false, error: "invalid_id" }, 400);
  const role = (request.headers.get("x-bridge-role") || "pc") as Role;
  if (!(await auth(env, room, role, token(request)))) return json({ ok: false, error: "unauthorized" }, 401);
  const m = await manifest(env, room, id);
  if (!m) return json({ ok: false, error: "not_found" }, 404);
  const keys = [keyBase(room, id)];
  for (const f of m.files) for (let i = 0; i < f.chunks; i++) keys.push(keyChunk(room, id, f.index, i));
  for (let i = 0; i < keys.length; i += 1000) await env.BACKUPS.delete(keys.slice(i, i + 1000));
  return json({ ok: true });
}

// ─────────────────────────────────────────────────────────
//  Main fetch handler
// ─────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env) {
    const u = new URL(request.url);
    const room = roomFrom(request);

    // Health
    if (u.pathname === "/health") {
      return json({
        ok: true, service: "wp2pc", roomDefault: DEFAULT_ROOM,
        storage: "r2",
        websocket: `${u.origin.replace("https:", "wss:").replace("http:", "ws:")}/ws`,
        ts: new Date().toISOString(),
      });
    }

    // WebSocket upgrade → PairRoom DO
    if (u.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected WebSocket upgrade", { status: 426 });
      if (!validRoom(room)) return new Response("Invalid room", { status: 400 });
      const role = u.searchParams.get("role");
      if (role !== "phone" && role !== "pc") return new Response("Invalid role", { status: 400 });
      const id = env.PAIR_ROOMS.idFromName(room);
      return env.PAIR_ROOMS.get(id).fetch(request);
    }

    // Pairing reset
    if (u.pathname === "/api/pairing/reset" && (request.method === "POST" || request.method === "DELETE")) {
      return resetPairing(request, env, room);
    }

    // Backup REST API
    if (u.pathname.startsWith("/api/backups")) {
      try {
        if (request.method === "POST" && u.pathname === "/api/backups/init")
          return initBackup(request, env, room);
        const p = u.pathname.split("/").filter(Boolean);
        if (u.pathname === "/api/backups/list" && request.method === "GET")
          return listBackups(request, env, room);
        if (p.length === 3 && p[1] === "backups" && request.method === "DELETE")
          return delBackup(request, env, room, p[2]);
        if (p.length === 4 && p[3] === "manifest" && request.method === "GET")
          return getManifest(request, env, room, p[2]);
        if (p.length === 7 && p[3] === "files" && p[5] === "chunks") {
          const fi = Number(p[4]), ci = Number(p[6]);
          if (!Number.isInteger(fi) || !Number.isInteger(ci) || fi < 0 || ci < 0)
            return json({ ok: false, error: "invalid_index" }, 400);
          if (request.method === "PUT") return putChunk(request, env, room, p[2], fi, ci);
          if (request.method === "GET") return getChunk(request, env, room, p[2], fi, ci);
        }
        if (p.length === 3 && p[1] === "backups" && request.method === "POST")
          return complete(request, env, room, p[2]);
        return json({ ok: false, error: "not_found" }, 404);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "request_failed" }, 500);
      }
    }

    // Static assets (Web UI)
    return env.ASSETS.fetch(request);
  },
};

// ─────────────────────────────────────────────────────────
//  PairRoom Durable Object
// ─────────────────────────────────────────────────────────
export class PairRoom extends DurableObject {
  private store() { return this.ctx.storage; }
  private record(role: Role) { return this.store().get<TokenRecord>(`token:${role}`); }
  private async valid(role: Role, t: string, device?: string) {
    const r = await this.record(role);
    if (!r || !t) return false;
    if (r.expiresAt !== null && Date.now() >= r.expiresAt) return false;
    if (device && r.deviceId !== device) return false;
    return (await hashHex(t)) === r.hash;
  }

  constructor(private ctx: DurableObjectState, env: Env) { super(ctx, env); }

  async fetch(request: Request) {
    const u = new URL(request.url);

    // ── Internal /auth RPC ──────────────────────────────
    if (u.pathname === "/auth") {
      const role = u.searchParams.get("role") as Role | null;
      const t = request.headers.get("x-bridge-token") || "";
      const d = request.headers.get("x-bridge-device") || "";
      if (role !== "phone" && role !== "pc") return new Response("bad", { status: 400 });
      return (await this.valid(role, t, d))
        ? new Response("ok")
        : new Response("unauthorized", { status: 401 });
    }

    // ── Internal /reset RPC ─────────────────────────────
    if (u.pathname === "/reset" && request.method === "POST") {
      // Close all open WebSockets with code 1008 (Policy Violation)
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1008, "Pairing reset"); } catch { /* already closed */ }
      }
      // Delete both token records
      await this.store().delete("token:phone");
      await this.store().delete("token:pc");
      return new Response("reset", { status: 200 });
    }

    // ── WebSocket upgrade ───────────────────────────────
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });

    const role = u.searchParams.get("role") as Role | null;
    if (role !== "phone" && role !== "pc") return new Response("Invalid role", { status: 400 });

    const t = u.searchParams.get("token") || "";
    const device = u.searchParams.get("deviceId") || "";
    const mode = u.searchParams.get("mode") === "reconnect" ? "reconnect" : "pair";

    // Replace any existing socket for the same role if the caller can authenticate
    const sockets = this.ctx.getWebSockets();
    let same: WebSocket | undefined;
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as { role?: string; deviceId?: string } | null;
      if (a?.role === role && ws.readyState === WebSocket.OPEN) { same = ws; break; }
    }
    if (same) {
      if (!(await this.valid(role, t, device))) return new Response("Already connected", { status: 409 });
      try { same.close(1000, "Replaced"); } catch { /* ignore */ }
    }

    const active = this.ctx.getWebSockets().filter(w => w.readyState === WebSocket.OPEN && w !== same);
    if (active.length >= 2) return new Response("Room full", { status: 409 });

    const existing = await this.record(role);
    let out = "";
    const effective = device || `${role}-${crypto.randomUUID()}`;

    if (mode === "reconnect") {
      if (!(await this.valid(role, t, effective))) return new Response("Unauthorized", { status: 401 });
    } else if (!existing) {
      // First pairing — generate and store token
      const raw = randomHex(32);
      out = raw;
      await this.store().put(`token:${role}`, {
        role, deviceId: effective, hash: await hashHex(raw),
        expiresAt: Date.now() + TOKEN_TTL_DAYS_DEFAULT * 86_400_000,
      } satisfies TokenRecord);
    } else if (t) {
      if (!(await this.valid(role, t, effective))) return new Response("Unauthorized", { status: 401 });
    } else {
      return new Response("Already paired", { status: 409 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role, deviceId: effective });

    // Send token only on first pair
    if (out) {
      pair[1].send(JSON.stringify({
        t: "device_token", token: out, deviceId: effective,
        expiresAt: Date.now() + TOKEN_TTL_DAYS_DEFAULT * 86_400_000,
      }));
    }
    pair[1].send(JSON.stringify({ t: "server_ready", role, room: u.searchParams.get("room") || DEFAULT_ROOM }));

    // Notify all sockets of peer status
    const all = this.ctx.getWebSockets().filter(w => w.readyState === WebSocket.OPEN);
    for (const ws of all) {
      ws.send(JSON.stringify({ t: all.length === 2 ? "peer_connected" : "peer_waiting" }));
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Handle ping/pong at the Worker level, relay everything else
    if (typeof message === "string") {
      try {
        const m = JSON.parse(message) as { t: string };
        if (m.t === "ping") { ws.send(JSON.stringify({ t: "pong", ts: Date.now() })); return; }
        if (m.t === "pong") return; // discard
      } catch { /* not JSON — relay as-is */ }
    }
    const peer = this.ctx.getWebSockets().find(w => w !== ws && w.readyState === WebSocket.OPEN);
    if (peer) try { peer.send(message); } catch { /* peer gone */ }
  }

  async webSocketClose(ws: WebSocket) {
    for (const p of this.ctx.getWebSockets()) {
      if (p !== ws && p.readyState === WebSocket.OPEN) {
        p.send(JSON.stringify({ t: "peer_disconnected" }));
      }
    }
  }

  async webSocketError(ws: WebSocket) {
    for (const p of this.ctx.getWebSockets()) {
      if (p !== ws && p.readyState === WebSocket.OPEN) {
        p.send(JSON.stringify({ t: "peer_error" }));
      }
    }
  }
}
