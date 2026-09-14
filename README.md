# WP2PC server full MVP

Cloudflare Worker + Durable Object + R2 + Web UI.

Features:
- Stable WebSocket pairing rooms.
- Device tokens with configurable expiration, including never-expire (until revoked).
- Default room ID: `24e30495a1ceeed42cdd2def95abcc2e`.
- R2-backed backup storage.
- Chunked encrypted upload/download endpoints.
- Resume-friendly per-chunk storage.
- Backup listing, manifest inspection, deletion.
- PC web UI for pairing, listing, downloading, and requesting restore.
- Health endpoint.

The application intentionally does not bypass Android/WhatsApp sandboxing and does not claim to control WhatsApp's internal backup database.
