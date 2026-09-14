(() => {
  const DEFAULT_ROOM = "24e30495a1ceeed42cdd2def95abcc2e";
  const roomKey = "wp2pc.room";
  const tokenKey = "wp2pc.pcToken";
  const deviceKey = "wp2pc.pcDeviceId";

  const $ = (id) => document.getElementById(id);
  const state = {
    socket: null,
    token: localStorage.getItem(tokenKey) || "",
    deviceId: localStorage.getItem(deviceKey) || "",
    backups: [],
    selected: null,
  };

  const baseUrl = location.origin;
  const wsBase = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  const room = localStorage.getItem(roomKey) || DEFAULT_ROOM;

  $("baseUrl").textContent = baseUrl;
  $("wsUrl").textContent = wsBase;
  $("defaultRoom").textContent = DEFAULT_ROOM;
  $("room").value = room;

  function log(message) {
    const el = $("log");
    el.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function status(kind, text) {
    const el = $("statusPill");
    el.className = `pill ${kind}`;
    el.textContent = text;
  }

  function setConnected(connected) {
    $("connect").disabled = connected;
    $("disconnect").disabled = !connected;
    $("refresh").disabled = !connected;
    status(connected ? "ok" : "pending", connected ? "CONNECTED" : "DISCONNECTED");
  }

  function randomRoom() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function authHeaders() {
    return {
      "x-bridge-role": "pc",
      "x-bridge-token": state.token,
    };
  }

  async function health() {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      const data = await response.json();
      $("storageText").textContent = data.storage === "r2" ? "R2 connected" : "Unknown";
      if (data.ok) status("ok", "ONLINE");
    } catch (error) {
      $("storageText").textContent = "Unavailable";
      status("bad", "OFFLINE");
      log(`Health error: ${error.message}`);
    }
  }

  function connect() {
    const roomId = $("room").value.trim();
    if (roomId.length < 8) {
      log("Room ID must be at least 8 characters.");
      return;
    }
    localStorage.setItem(roomKey, roomId);

    if (state.socket && state.socket.readyState <= WebSocket.OPEN) state.socket.close();

    const params = new URLSearchParams({ room: roomId, role: "pc" });
    params.set("mode", state.token ? "reconnect" : "pair");
    if (state.token) params.set("token", state.token);
    if (state.deviceId) params.set("deviceId", state.deviceId);

    const url = `${wsBase}?${params.toString()}`;
    log(`Connecting to ${url}`);
    const socket = new WebSocket(url);
    state.socket = socket;
    $("connect").disabled = true;

    socket.addEventListener("open", () => {
      status("ok", "CONNECTED");
      log("WebSocket connected.");
    });

    socket.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return;
      log(`Received: ${event.data}`);
      try {
        const message = JSON.parse(event.data);
        if (message.t === "device_token") {
          state.token = message.token;
          state.deviceId = message.deviceId;
          localStorage.setItem(tokenKey, state.token);
          localStorage.setItem(deviceKey, state.deviceId);
          $("deviceId").textContent = state.deviceId;
          $("expiresAt").textContent = message.expiresAt ? new Date(message.expiresAt).toLocaleString() : "Until revoked";
          await refreshBackups();
        }
        if (message.t === "server_ready") {
          $("deviceId").textContent = message.deviceId || state.deviceId || "-";
          await refreshBackups();
        }
        if (message.t === "peer_connected") {
          log("Phone connected.");
        }
        if (message.t === "peer_disconnected") {
          log("Phone disconnected.");
        }
      } catch {
        // Ignore non-JSON websocket payloads.
      }
    });

    socket.addEventListener("close", (event) => {
      log(`WebSocket closed (${event.code}).`);
      setConnected(false);
    });
    socket.addEventListener("error", () => {
      log("WebSocket error.");
      setConnected(false);
    });
  }

  function disconnect() {
    if (state.socket) state.socket.close(1000, "user_disconnect");
    state.socket = null;
    setConnected(false);
  }

  async function refreshBackups() {
    if (!state.token) {
      $("emptyState").hidden = false;
      $("backupList").hidden = true;
      return;
    }
    const roomId = $("room").value.trim() || DEFAULT_ROOM;
    const response = await fetch(`/api/backups/list?room=${encodeURIComponent(roomId)}`, { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      log(`Backup list error: ${data.error || response.status}`);
      return;
    }
    state.backups = data.backups;
    renderBackups();
  }

  function renderBackups() {
    const list = $("backupList");
    list.innerHTML = "";
    $("emptyState").hidden = state.backups.length > 0;
    list.hidden = state.backups.length === 0;
    $("delete").disabled = !state.selected;
    $("restore").disabled = !state.selected;

    for (const backup of state.backups) {
      const item = document.createElement("div");
      item.className = `backupItem${state.selected?.backupId === backup.backupId ? " selected" : ""}`;
      item.innerHTML = `
        <div class="backupItemTop">
          <strong>${escapeHtml(backup.backupId)}</strong>
          <span class="badge">${backup.encrypted ? "ENCRYPTED" : "UNENCRYPTED"}</span>
        </div>
        <div class="muted small">${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.totalBytes)} · ${backup.fileCount} files</div>
      `;
      item.addEventListener("click", () => selectBackup(backup));
      list.appendChild(item);
    }
  }

  async function selectBackup(backup) {
    state.selected = backup;
    renderBackups();
    const roomId = $("room").value.trim() || DEFAULT_ROOM;
    const response = await fetch(`/api/backups/${encodeURIComponent(backup.backupId)}/manifest?room=${encodeURIComponent(roomId)}`, { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      $("details").textContent = `Manifest error: ${data.error || response.status}`;
      return;
    }
    $("details").textContent = JSON.stringify(data.manifest, null, 2);
  }

  async function deleteSelected() {
    if (!state.selected) return;
    if (!confirm(`Delete ${state.selected.backupId}?`)) return;
    const roomId = $("room").value.trim() || DEFAULT_ROOM;
    const response = await fetch(`/api/backups/${encodeURIComponent(state.selected.backupId)}?room=${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      log(`Delete error: ${data.error || response.status}`);
      return;
    }
    state.selected = null;
    $("details").textContent = "No backup selected.";
    log(`Deleted ${data.backupId}`);
    await refreshBackups();
  }

  function requestRestore() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.selected) {
      log("Connect to a PC/phone room and select a backup first.");
      return;
    }
    state.socket.send(JSON.stringify({
      t: "restore_request",
      backupId: state.selected.backupId,
      roomId: $("room").value.trim(),
    }));
    log(`Restore request sent for ${state.selected.backupId}.`);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = "B";
    for (const candidate of units) {
      value /= 1024;
      unit = candidate;
      if (value < 1024) break;
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
  }

  $("newRoom").addEventListener("click", () => {
    const newValue = randomRoom();
    $("room").value = newValue;
    localStorage.setItem(roomKey, newValue);
    log(`New room generated: ${newValue}`);
  });
  $("connect").addEventListener("click", connect);
  $("disconnect").addEventListener("click", disconnect);
  $("refresh").addEventListener("click", () => refreshBackups().catch((error) => log(`Refresh error: ${error.message}`)));
  $("delete").addEventListener("click", () => deleteSelected().catch((error) => log(`Delete error: ${error.message}`)));
  $("restore").addEventListener("click", requestRestore);
  $("backupNow").addEventListener("click", () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      log("Connect first.");
      return;
    }
    const roomId = $("room").value.trim() || DEFAULT_ROOM;
    state.socket.send(JSON.stringify({
      t: "backup_request",
      roomId,
    }));
    log("Backup request sent to the paired phone.");
  });

  $("deviceId").textContent = state.deviceId || "-";
  $("expiresAt").textContent = state.token ? "Saved token" : "-";
  setConnected(false);
  health();
})();
