# WP2PC WebSocket Protocol

**Version**: 1  
**Transport**: WebSocket over TLS (`wss://`)  
**Endpoint**: `wss://wp2pc.ceaxres.workers.dev/ws`  
**Default room**: `24e30495a1ceeed42cdd2def95abcc2e`

---

## Connection Parameters

Every WebSocket connection must include these query parameters:

| Parameter  | Required | Values                  | Description                                      |
|------------|----------|-------------------------|--------------------------------------------------|
| `room`     | yes      | 8–96 alphanumeric chars | Room identifier shared by both devices           |
| `role`     | yes      | `pc` or `phone`         | Identity of the connecting device                |
| `mode`     | yes      | `pair` or `reconnect`   | `pair` = first connection; `reconnect` = token auth |
| `deviceId` | yes      | opaque string           | Stable device identifier (generated on first pair) |
| `token`    | conditionally | hex string         | Required when `mode=reconnect`; omit on `mode=pair` |

Example (first pair):
```
wss://wp2pc.ceaxres.workers.dev/ws?room=24e30495...&role=pc&mode=pair&deviceId=pc-abcd1234
```

Example (reconnect):
```
wss://wp2pc.ceaxres.workers.dev/ws?room=24e30495...&role=pc&mode=reconnect&deviceId=pc-abcd1234&token=<hex>
```

---

## Frame Types

All WebSocket frames are either:

- **Text frames** — UTF-8 JSON. Every message has a `"t"` field as a type discriminator.
- **Binary frames** — raw bytes. A binary frame **must immediately follow** a `backup_chunk` or `restore_chunk` text frame. No binary frame is valid without a preceding metadata text frame.

### Binary Frame Association Rule

```
TEXT  { "t": "backup_chunk", "jobId": "...", "fileIndex": 0, "chunkIndex": 0, "chunkSize": 8388608, ... }
BINARY  <exactly chunkSize bytes of AES-256-GCM ciphertext + 16-byte auth tag>
```

The receiver must buffer the last `backup_chunk` / `restore_chunk` metadata and apply it to the next binary frame. If a binary frame arrives with no pending metadata, it must be discarded with an error.

---

## Message Reference

### Server → Client

#### `server_ready`
Sent immediately after the WebSocket is accepted (after `device_token` if applicable).

```json
{
  "t": "server_ready",
  "role": "pc",
  "room": "24e30495a1ceeed42cdd2def95abcc2e"
}
```

#### `device_token`
Sent **only on the very first pairing** (`mode=pair` and no prior token stored). The client must persist this token securely and use it for all future `mode=reconnect` connections.

```json
{
  "t": "device_token",
  "token": "<64-hex-char raw token>",
  "deviceId": "pc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "expiresAt": 1788888888000
}
```

> **Security**: The raw token is transmitted over the already-TLS-protected WebSocket. The server stores only the SHA-256 hash. The client must store the raw token via DPAPI (Windows) or Android Keystore (Android).

#### `peer_waiting`
One device is connected; the other has not connected yet.

```json
{ "t": "peer_waiting" }
```

#### `peer_connected`
Both devices are now connected to the room.

```json
{ "t": "peer_connected" }
```

#### `peer_disconnected`
The other device's WebSocket closed.

```json
{ "t": "peer_disconnected" }
```

#### `peer_error`
The other device's WebSocket errored.

```json
{ "t": "peer_error" }
```

#### `pong`
Response to a `ping` message.

```json
{ "t": "pong", "ts": 1788888888000 }
```

---

### Client ↔ Client (relayed through server)

The server relays all messages not handled natively (i.e. everything except `ping`/`pong`) transparently to the peer. The originating role is not added by the server — clients must include it if needed.

#### `ping`
Keepalive. Server responds with `pong`; does **not** relay to peer.

```json
{ "t": "ping" }
```

---

### Backup Flow (Phone → PC)

#### `backup_request`
PC asks phone to start a backup.

```json
{
  "t": "backup_request",
  "jobId": "<uuid>"
}
```

#### `backup_begin`
Phone acknowledges and describes the backup.

```json
{
  "t": "backup_begin",
  "jobId": "<uuid>",
  "fileCount": 1234,
  "totalBytes": 4831838208,
  "deviceId": "phone-xxxx",
  "createdAt": "2026-09-17T10:00:00Z"
}
```

#### `backup_file`
Phone announces the next file to transfer.

```json
{
  "t": "backup_file",
  "jobId": "<uuid>",
  "fileIndex": 0,
  "path": "WhatsApp/Media/WhatsApp Images/IMG_20260101_000001.jpg",
  "size": 1048576,
  "chunkCount": 1,
  "sha256": "<hex>"
}
```

#### `backup_chunk`
Phone announces the next chunk. The **immediately following binary frame** contains the ciphertext.

```json
{
  "t": "backup_chunk",
  "jobId": "<uuid>",
  "fileIndex": 0,
  "chunkIndex": 0,
  "chunkSize": 1048592,
  "totalChunks": 1,
  "iv": "<base64 12-byte nonce>",
  "aad": "<base64 UTF-8 of 'jobId:fileIndex:chunkIndex'>"
}
```

Binary frame: `[ciphertext || 16-byte GCM auth tag]`, exactly `chunkSize` bytes total.

#### `backup_end`
Phone signals all files have been sent.

```json
{
  "t": "backup_end",
  "jobId": "<uuid>",
  "fileCount": 1234,
  "totalBytes": 4831838208
}
```

#### `backup_complete`
PC confirms backup was received and written to disk.

```json
{
  "t": "backup_complete",
  "jobId": "<uuid>"
}
```

#### `backup_error`
Either side signals a backup failure.

```json
{
  "t": "backup_error",
  "jobId": "<uuid>",
  "reason": "disk_full"
}
```

---

### Restore Flow (PC → Phone)

#### `restore_request`
PC sends phone the manifest of a backup it wants to restore.

```json
{
  "t": "restore_request",
  "jobId": "<uuid>",
  "manifest": { /* Manifest object — same schema as R2 manifest */ }
}
```

#### `restore_begin`
Phone accepts the restore and is ready to receive data.

```json
{
  "t": "restore_begin",
  "jobId": "<uuid>"
}
```

#### `restore_file`
PC announces the next file it will send.

```json
{
  "t": "restore_file",
  "jobId": "<uuid>",
  "fileIndex": 0,
  "path": "WhatsApp/Media/WhatsApp Images/IMG_20260101_000001.jpg",
  "size": 1048576,
  "chunkCount": 1
}
```

#### `restore_chunk`
PC announces the next chunk. The **immediately following binary frame** contains the ciphertext.

```json
{
  "t": "restore_chunk",
  "jobId": "<uuid>",
  "fileIndex": 0,
  "chunkIndex": 0,
  "chunkSize": 1048592,
  "totalChunks": 1,
  "iv": "<base64 12-byte nonce>",
  "aad": "<base64 UTF-8 of 'jobId:fileIndex:chunkIndex'>"
}
```

Binary frame: `[ciphertext || 16-byte GCM auth tag]`, exactly `chunkSize` bytes.

#### `restore_end`
PC signals all chunks have been sent.

```json
{
  "t": "restore_end",
  "jobId": "<uuid>"
}
```

#### `restore_complete`
Phone confirms all files were written to disk.

```json
{
  "t": "restore_complete",
  "jobId": "<uuid>"
}
```

#### `restore_error`
Either side signals a restore failure.

```json
{
  "t": "restore_error",
  "jobId": "<uuid>",
  "reason": "no_space"
}
```

---

## Encryption Scheme

- **Algorithm**: AES-256-GCM
- **Key size**: 256 bits (32 bytes)
- **Nonce (IV)**: 12 bytes, cryptographically random, unique per chunk
- **Auth tag**: 128 bits (16 bytes), appended to ciphertext
- **AAD**: UTF-8 bytes of `"{jobId}:{fileIndex}:{chunkIndex}"` — authenticated but not encrypted
- **Wire format per chunk**: `IV (12 bytes) || ciphertext || auth tag (16 bytes)` — but in the WebSocket protocol the IV is sent as `base64` in the JSON metadata frame and the binary frame is `ciphertext || auth tag` only

> The receiver must use `iv` from the JSON frame plus the `aad` field to authenticate and decrypt the binary payload. Failure to authenticate must abort the transfer with `backup_error` / `restore_error`.

---

## Key Exchange

On first pairing, Android generates an AES-256 key in the Android Keystore. It sends the raw key bytes over the TLS WebSocket as a `key_exchange` message:

```json
{
  "t": "key_exchange",
  "keyId": "wp2pc_aes_key_v1",
  "keyBytes": "<base64 32 bytes>",
  "algorithm": "AES-256-GCM"
}
```

The PC receives this and stores the key via DPAPI (`ProtectedData.Protect`) in `%APPDATA%\WP2PC\crypto.dat`.  
This message is sent exactly once per pairing. After `RESET PAIRING`, the key is discarded on both sides and regenerated on the next pairing.

---

## Connection State Machine

```
[DISCONNECTED]
     │  user clicks CONNECT / app starts
     ▼
[CONNECTING] — WebSocket handshake
     │  onopen
     ▼
[CONNECTED] ──── server sends server_ready
     │  if first pair: server also sends device_token (save it)
     │
     ├── peer not yet connected → server sends peer_waiting → [WAITING_FOR_PEER]
     │       │  other device connects
     │       ▼
     └── [PEER_CONNECTED] ←── server sends peer_connected
              │  transfer messages flow
              │  peer drops
              ▼
          [WAITING_FOR_PEER] ← server sends peer_disconnected

[CONNECTED] or [WAITING_FOR_PEER]
     │  user clicks DISCONNECT
     ▼
[DISCONNECTED]  ← pairing record remains intact on server

[CONNECTED/WAITING_FOR_PEER]
     │  user clicks RESET PAIRING
     ▼
POST /api/pairing/reset  →  server deletes tokens, closes all sockets
[DISCONNECTED]  ← must pair again
```

---

## Reconnect Backoff

Clients must implement exponential backoff on reconnect:

| Attempt | Delay |
|---------|-------|
| 1       | 2 s   |
| 2       | 4 s   |
| 3       | 8 s   |
| 4       | 16 s  |
| 5+      | 60 s  |

A manual DISCONNECT by the user must stop reconnection.

---

## R2 REST API Reference

All R2 endpoints require:
- `?room=<roomId>` query parameter
- `x-bridge-token: <raw token>` header
- `x-bridge-role: phone` or `x-bridge-role: pc` header

| Method   | Path                                               | Role  | Description              |
|----------|----------------------------------------------------|-------|--------------------------|
| `POST`   | `/api/backups/init`                                | phone | Create backup manifest   |
| `PUT`    | `/api/backups/{id}/files/{fi}/chunks/{ci}`         | phone | Upload encrypted chunk   |
| `POST`   | `/api/backups/{id}`                                | phone | Finalize backup manifest |
| `GET`    | `/api/backups/list`                                | pc    | List completed backups   |
| `GET`    | `/api/backups/{id}/manifest`                       | pc    | Fetch manifest           |
| `GET`    | `/api/backups/{id}/files/{fi}/chunks/{ci}`         | pc    | Download chunk           |
| `DELETE` | `/api/backups/{id}`                                | pc    | Delete backup + chunks   |
| `POST`   | `/api/pairing/reset`                               | either | Reset pairing tokens    |

---

## Error Responses

All REST errors return JSON:

```json
{ "ok": false, "error": "<error_code>" }
```

Common error codes: `unauthorized`, `invalid_room`, `not_found`, `chunk_too_large`, `invalid_path`, `invalid_manifest`, `backup_not_found`, `request_failed`.

WebSocket connection rejections use HTTP status codes: `400` (bad params), `401` (bad token), `409` (conflict: already connected / room full / already paired), `426` (not a WebSocket).
