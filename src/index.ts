import { DurableObject } from "cloudflare:workers";

const DEFAULT_ROOM_ID = "24e30495a1ceeed42cdd2def95abcc2e";
const MAX_ROOM_LENGTH = 96;
const MAX_TOKEN_LENGTH = 256;
const MAX_BACKUP_ID_LENGTH = 96;
const MAX_PATH_LENGTH = 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_CHUNKS_PER_FILE = 1_000_000;
const DEFAULT_AUTH_DAYS = 365;

type Role = "pc" | "phone";

type TokenRecord = {
  role: Role;
  deviceId: string;
  tokenHash: string;
  expiresAt: number | null;
  createdAt: number;
};

type FileManifest = {
  index: number;
  path: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunks: number;
  sha256: string;
};

type BackupManifest = {
  version: 3;
  backupId: string;
  roomId: string;
  createdAt: string;
  completedAt?: string;
  deviceId: string;
  encrypted: true;
  encryption: {
    algorithm: string;
    keyId: string;
  };
  totalBytes: number;
  files: FileManifest[];
};

type WsAttachment = {
  role: Role;
  room: string;
  deviceId: string;
  connectedAt: number;
};

interface Env {
  PAIR_ROOMS: DurableObjectNamespace;
  BACKUPS: R2Bucket;
  ASSETS: Fetcher;
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function roomOk(room: string): boolean {
  return /^[A-Za-z0-9._:-]{8,96}$/.test(room);
}

function backupIdOk(id: string): boolean {
  return /^[A-Za-z0-9._:-]{8,96}$/.test(id);
}

function safePath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false;
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) return false;
  return !path.split("/").some((part) => part === ".." || part === "");
}

function randomHex(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenFrom(request: Request): string {
  return request.headers.get("x-bridge-token")?.trim() || "";
}

function roleFrom(request: Request): Role | null {
  const role = request.headers.get("x-bridge-role")?.trim();
  return role === "pc" || role === "phone" ? role : null;
}

function roomFrom(request: Request): string {
  return new URL(request.url).searchParams.get("room")?.trim() || DEFAULT_ROOM_ID;
}

function metaKey(room: string, backupId: string): string {
  return `backups/${room}/meta/${backupId}.json`;
}

function chunkKey(room: string, backupId: string, fileIndex: number, chunkIndex: number): string {
  return `backups/${room}/${backupId}/files/${fileIndex}/${chunkIndex}.bin`;
}

function parseSafeIndex(value: string | null, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

async function getManifest(env: Env, room: string, backupId: string): Promise<BackupManifest | null> {
  const object = await env.BACKUPS.get(metaKey(room, backupId));
  if (!object) return null;
  try {
    return await object.json<BackupManifest>();
  } catch {
    return null;
  }
}

async function authorize(env: Env, room: string, role: Role, token: string): Promise<boolean> {
  if (!roomOk(room) || !token || token.length > MAX_TOKEN_LENGTH) return false;
  const id = env.PAIR_ROOMS.idFromName(room);
  const stub = env.PAIR_ROOMS.get(id);
  const result = await stub.fetch(
    new Request("https://internal/authorize", {
      headers: {
        "x-bridge-role": role,
        "x-bridge-token": token,
      },
    }),
  );
  return result.ok;
}

async function requireAuth(env: Env, request: Request, room: string, expectedRole?: Role): Promise<Role | null> {
  const role = roleFrom(request);
  if (!role || (expectedRole && role !== expectedRole)) return null;
  return (await authorize(env, room, role, tokenFrom(request))) ? role : null;
}

async function apiHealth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return json({
    ok: true,
    service: "wp2pc",
    worker: "wp2pc",
    storage: "r2",
    defaultRoom: DEFAULT_ROOM_ID,
    websocket: `${url.origin.replace("https:", "wss:").replace("http:", "ws:")}/ws`,
    timestamp: new Date().toISOString(),
  });
}

async function apiBackupInit(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const room = String(body?.roomId ?? roomFrom(request)).trim();
  const role = await requireAuth(env, request, room, "phone");
  const deviceId = String(body?.deviceId ?? "").trim();
  if (!role || !deviceId) return json({ ok: false, error: "unauthorized" }, 401);

  const backupId = `b-${Date.now().toString(36)}-${randomHex(8)}`;
  const keyId = String(body?.keyId ?? "android-keystore-v1");
  const manifest: BackupManifest = {
    version: 3,
    backupId,
    roomId: room,
    createdAt: new Date().toISOString(),
    deviceId,
    encrypted: true,
    encryption: {
      algorithm: "AES-256-GCM-chunked",
      keyId,
    },
    totalBytes: 0,
    files: [],
  };
  await env.BACKUPS.put(metaKey(room, backupId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return json({ ok: true, backupId, chunkMaxBytes: MAX_CHUNK_BYTES, roomId: room });
}

async function apiUploadChunk(
  request: Request,
  env: Env,
  room: string,
  backupId: string,
  fileIndex: number,
  chunkIndex: number,
): Promise<Response> {
  if (fileIndex > MAX_FILES || chunkIndex > MAX_CHUNKS_PER_FILE) {
    return json({ ok: false, error: "index_out_of_range" }, 400);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_CHUNK_BYTES) return json({ ok: false, error: "chunk_too_large" }, 413);

  const manifest = await getManifest(env, room, backupId);
  if (!manifest) return json({ ok: false, error: "backup_not_found" }, 404);
  if (manifest.completedAt) return json({ ok: false, error: "backup_completed" }, 409);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CHUNK_BYTES) return json({ ok: false, error: "chunk_too_large" }, 413);

  await env.BACKUPS.put(chunkKey(room, backupId, fileIndex, chunkIndex), body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      encrypted: "1",
      backupId,
      fileIndex: String(fileIndex),
      chunkIndex: String(chunkIndex),
    },
  });

  return json({ ok: true, backupId, fileIndex, chunkIndex, bytes: body.byteLength });
}

function validateManifest(manifest: unknown, room: string, backupId: string): manifest is BackupManifest {
  if (!manifest || typeof manifest !== "object") return false;
  const data = manifest as Partial<BackupManifest>;
  if (data.version !== 3 || data.backupId !== backupId || data.roomId !== room) return false;
  if (data.encrypted !== true || !Array.isArray(data.files) || data.files.length > MAX_FILES) return false;
  if (!Number.isSafeInteger(data.totalBytes) || Number(data.totalBytes) < 0) return false;
  for (const file of data.files) {
    if (!file || typeof file !== "object") return false;
    const item = file as Partial<FileManifest>;
    if (!Number.isSafeInteger(item.index) || Number(item.index) < 0 || Number(item.index) > MAX_FILES) return false;
    if (!safePath(String(item.path ?? ""))) return false;
    if (!Number.isSafeInteger(item.size) || Number(item.size) < 0) return false;
    if (!Number.isSafeInteger(item.chunkSize) || Number(item.chunkSize) <= 0 || Number(item.chunkSize) > MAX_CHUNK_BYTES) return false;
    if (!Number.isSafeInteger(item.chunks) || Number(item.chunks) < 0 || Number(item.chunks) > MAX_CHUNKS_PER_FILE) return false;
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return false;
  }
  return true;
}

async function apiBackupComplete(request: Request, env: Env, room: string, backupId: string): Promise<Response> {
  const role = await requireAuth(env, request, room, "phone");
  if (!role) return json({ ok: false, error: "unauthorized" }, 401);

  const current = await getManifest(env, room, backupId);
  if (!current) return json({ ok: false, error: "backup_not_found" }, 404);
  if (current.completedAt) return json({ ok: true, backupId, alreadyCompleted: true });

  const candidate = await request.json().catch(() => null);
  if (!validateManifest(candidate, room, backupId)) return json({ ok: false, error: "invalid_manifest" }, 400);

  const manifest = candidate as BackupManifest;
  if (manifest.deviceId !== current.deviceId || manifest.encryption.keyId !== current.encryption.keyId) {
    return json({ ok: false, error: "manifest_mismatch" }, 409);
  }

  // Verify that every referenced chunk exists before marking the backup complete.
  for (const file of manifest.files) {
    for (let chunkIndex = 0; chunkIndex < file.chunks; chunkIndex++) {
      const head = await env.BACKUPS.head(chunkKey(room, backupId, file.index, chunkIndex));
      if (!head) return json({ ok: false, error: "missing_chunk", fileIndex: file.index, chunkIndex }, 409);
    }
  }

  manifest.completedAt = new Date().toISOString();
  await env.BACKUPS.put(metaKey(room, backupId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return json({ ok: true, backupId, completedAt: manifest.completedAt });
}

async function apiList(request: Request, env: Env, room: string): Promise<Response> {
  const role = await requireAuth(env, request, room);
  if (!role) return json({ ok: false, error: "unauthorized" }, 401);

  const backups: Array<{
    backupId: string;
    createdAt: string;
    completedAt: string;
    totalBytes: number;
    fileCount: number;
    encrypted: true;
    deviceId: string;
  }> = [];
  let cursor: string | undefined;
  do {
    const listed = await env.BACKUPS.list({ prefix: `backups/${room}/meta/`, cursor, limit: 1000 });
    for (const object of listed.objects) {
      const metadata = await env.BACKUPS.get(object.key);
      if (!metadata) continue;
      try {
        const manifest = await metadata.json<BackupManifest>();
        if (!manifest.completedAt) continue;
        backups.push({
          backupId: manifest.backupId,
          createdAt: manifest.createdAt,
          completedAt: manifest.completedAt,
          totalBytes: manifest.totalBytes,
          fileCount: manifest.files.length,
          encrypted: true,
          deviceId: manifest.deviceId,
        });
      } catch {
        // Ignore malformed metadata.
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ ok: true, roomId: room, backups });
}

async function apiManifest(request: Request, env: Env, room: string, backupId: string): Promise<Response> {
  const role = await requireAuth(env, request, room);
  if (!role) return json({ ok: false, error: "unauthorized" }, 401);
  const manifest = await getManifest(env, room, backupId);
  return manifest ? json({ ok: true, manifest }) : json({ ok: false, error: "not_found" }, 404);
}

async function apiChunk(request: Request, env: Env, room: string, backupId: string, fileIndex: number, chunkIndex: number): Promise<Response> {
  const role = await requireAuth(env, request, room);
  if (!role) return json({ ok: false, error: "unauthorized" }, 401);
  const manifest = await getManifest(env, room, backupId);
  if (!manifest) return json({ ok: false, error: "not_found" }, 404);
  const obj = await env.BACKUPS.get(chunkKey(room, backupId, fileIndex, chunkIndex));
  if (!obj) return json({ ok: false, error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      etag: obj.httpEtag,
    },
  });
}

async function apiDelete(request: Request, env: Env, room: string, backupId: string): Promise<Response> {
  const role = await requireAuth(env, request, room, "pc");
  if (!role) return json({ ok: false, error: "unauthorized" }, 401);
  const manifest = await getManifest(env, room, backupId);
  if (!manifest) return json({ ok: false, error: "not_found" }, 404);

  const keys: string[] = [metaKey(room, backupId)];
  for (const file of manifest.files) {
    for (let i = 0; i < file.chunks; i++) keys.push(chunkKey(room, backupId, file.index, i));
  }
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BACKUPS.delete(keys.slice(i, i + 1000));
  }
  return json({ ok: true, backupId });
}

function wsUrl(request: Request, room: string, role: Role, token?: string, deviceId?: string): string {
  const url = new URL(request.url);
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("room", room);
  url.searchParams.set("role", role);
  url.searchParams.set("mode", token ? "reconnect" : "pair");
  if (token) url.searchParams.set("token", token);
  if (deviceId) url.searchParams.set("deviceId", deviceId);
  return url.toString().replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") return apiHealth(request);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const room = roomFrom(request);
      if (!roomOk(room)) return new Response("Invalid room", { status: 400 });
      const role = url.searchParams.get("role") as Role | null;
      if (role !== "pc" && role !== "phone") return new Response("Invalid role", { status: 400 });
      const id = env.PAIR_ROOMS.idFromName(room);
      return env.PAIR_ROOMS.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/api/backups")) {
      try {
        const room = roomFrom(request);
        const parts = url.pathname.split("/").filter(Boolean);
        if (!roomOk(room)) return json({ ok: false, error: "invalid_room" }, 400);

        if (url.pathname === "/api/backups/init" && request.method === "POST") {
          return await apiBackupInit(request, env);
        }

        if (url.pathname === "/api/backups/list" && request.method === "GET") {
          return await apiList(request, env, room);
        }

        if (parts.length === 7 && parts[0] === "api" && parts[1] === "backups" && parts[3] === "files" && parts[5] === "chunks") {
          const backupId = parts[2];
          if (!backupIdOk(backupId)) return json({ ok: false, error: "invalid_backup_id" }, 400);
          const fileIndex = parseSafeIndex(parts[4], MAX_FILES);
          const chunkIndex = parseSafeIndex(parts[6], MAX_CHUNKS_PER_FILE);
          if (fileIndex === null || chunkIndex === null) return json({ ok: false, error: "invalid_index" }, 400);
          if (request.method === "PUT") {
            const role = await requireAuth(env, request, room, "phone");
            if (!role) return json({ ok: false, error: "unauthorized" }, 401);
            return await apiUploadChunk(request, env, room, backupId, fileIndex, chunkIndex);
          }
          if (request.method === "GET") return await apiChunk(request, env, room, backupId, fileIndex, chunkIndex);
        }

        if (parts.length === 3 && parts[0] === "api" && parts[1] === "backups") {
          const backupId = parts[2];
          if (!backupIdOk(backupId)) return json({ ok: false, error: "invalid_backup_id" }, 400);
          if (request.method === "POST") return await apiBackupComplete(request, env, room, backupId);
          if (request.method === "DELETE") return await apiDelete(request, env, room, backupId);
        }

        if (parts.length === 4 && parts[0] === "api" && parts[1] === "backups" && parts[3] === "manifest" && request.method === "GET") {
          const backupId = parts[2];
          if (!backupIdOk(backupId)) return json({ ok: false, error: "invalid_backup_id" }, 400);
          return await apiManifest(request, env, room, backupId);
        }

        return json({ ok: false, error: "not_found" }, 404);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : "request_failed" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

export class PairRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async recordFor(role: Role): Promise<TokenRecord | null> {
    return (await this.ctx.storage.get<TokenRecord>(`token:${role}`)) ?? null;
  }

  private expired(record: TokenRecord | null): boolean {
    return !!record && record.expiresAt !== null && Date.now() >= record.expiresAt;
  }

  private async issueToken(role: Role, deviceId: string, ttlDays: number): Promise<TokenRecord> {
    const token = randomHex(32);
    const safeDays = Number.isFinite(ttlDays) ? Math.max(0, Math.min(3650, Math.floor(ttlDays))) : DEFAULT_AUTH_DAYS;
    const expiresAt = safeDays === 0 ? null : Date.now() + safeDays * 86_400_000;
    const record: TokenRecord = {
      role,
      deviceId,
      tokenHash: await sha256Hex(token),
      expiresAt,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`token:${role}`, record);
    return { ...record, tokenHash: token };
  }

  private async validate(role: Role, token: string, deviceId?: string): Promise<boolean> {
    if (!token || token.length > MAX_TOKEN_LENGTH) return false;
    const record = await this.recordFor(role);
    if (!record || this.expired(record)) return false;
    if (deviceId && record.deviceId !== deviceId) return false;
    return (await sha256Hex(token)) === record.tokenHash;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      const role = url.searchParams.get("role") as Role | null;
      const token = request.headers.get("x-bridge-token") || "";
      const deviceId = request.headers.get("x-bridge-device-id") || undefined;
      if (role !== "pc" && role !== "phone") return new Response("invalid", { status: 400 });
      return (await this.validate(role, token, deviceId)) ? new Response("ok") : new Response("unauthorized", { status: 401 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });

    const role = url.searchParams.get("role") as Role | null;
    const room = url.searchParams.get("room")?.trim() || DEFAULT_ROOM_ID;
    const mode = url.searchParams.get("mode") === "reconnect" ? "reconnect" : "pair";
    const token = url.searchParams.get("token") || "";
    const deviceId = url.searchParams.get("deviceId") || `${role}-${randomHex(8)}`;
    const ttlDays = Number(url.searchParams.get("ttlDays") || DEFAULT_AUTH_DAYS);
    if (role !== "pc" && role !== "phone") return new Response("Invalid role", { status: 400 });
    if (!roomOk(room)) return new Response("Invalid room", { status: 400 });

    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      if (attachment?.role !== role) continue;
      if (!(await this.validate(role, token, deviceId))) return new Response("Role already connected", { status: 409 });
      try { ws.close(1000, "Replaced by new session"); } catch { /* ignore */ }
    }

    const active = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    if (active.length >= 2) return new Response("Room full", { status: 409 });

    let issuedToken = "";
    const currentRecord = await this.recordFor(role);

    if (mode === "reconnect") {
      if (!(await this.validate(role, token, deviceId))) return new Response("Unauthorized", { status: 401 });
    } else if (!currentRecord || this.expired(currentRecord)) {
      const issued = await this.issueToken(role, deviceId, ttlDays);
      issuedToken = issued.tokenHash;
    } else {
      if (!token || !(await this.validate(role, token, deviceId))) return new Response("Already paired", { status: 409 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, room, deviceId, connectedAt: Date.now() } satisfies WsAttachment);

    if (issuedToken) {
      const record = await this.recordFor(role);
      server.send(JSON.stringify({
        t: "device_token",
        role,
        deviceId,
        token: issuedToken,
        expiresAt: record?.expiresAt ?? null,
      }));
    }

    server.send(JSON.stringify({ t: "server_ready", role, room, deviceId }));

    const all = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    if (all.length === 2) {
      for (const ws of all) ws.send(JSON.stringify({ t: "peer_connected" }));
    } else {
      server.send(JSON.stringify({ t: "peer_waiting" }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = this.ctx.getWebSockets().find((candidate) => candidate !== ws && candidate.readyState === WebSocket.OPEN);
    if (!peer) {
      if (ws.readyState === WebSocket.OPEN && typeof message === "string") ws.send(JSON.stringify({ t: "peer_waiting" }));
      return;
    }
    try {
      peer.send(message);
    } catch {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "relay_error" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ t: "peer_disconnected", code, reason }));
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ t: "peer_error" }));
    }
  }
}

export { DEFAULT_ROOM_ID, MAX_CHUNK_BYTES, wsUrl };
