(() => {
  // ── Storage keys ──────────────────────────────────────────────────────────
  const ROOM_KEY = 'wp2pc.room';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const roomInput     = /** @type {HTMLInputElement}  */ (document.getElementById('room'));
  const roomDisplay   = document.getElementById('roomDisplay');
  const logEl         = document.getElementById('log');
  const stServer      = document.getElementById('st-server');
  const stPc          = document.getElementById('st-pc');
  const stPhone       = document.getElementById('st-phone');
  const backupList    = document.getElementById('backupList');

  // ── State ─────────────────────────────────────────────────────────────────
  let ws = null;
  let pingInterval = null;
  let peerConnected = false;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function log(msg, level = 'info') {
    const ts = new Date().toLocaleTimeString();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    logEl.textContent += `${ts} ${prefix} ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setPill(el, text, state = '') {
    el.textContent = text;
    el.className = 'pill' + (state ? ' ' + state : '');
  }

  function storageKey(name, room = getRoom()) { return `wp2pc.${room}.pc.${name}`; }
  function getRoom()   { return roomInput.value.trim(); }
  function getToken()  { return localStorage.getItem(storageKey('token')) || ''; }
  function getDevice() {
    let d = localStorage.getItem(storageKey('device'));
    if (!d) { d = 'pc-' + crypto.randomUUID(); localStorage.setItem(storageKey('device'), d); }
    return d;
  }

  function wsUrl() {
    const r = encodeURIComponent(getRoom());
    const t = getToken();
    const d = encodeURIComponent(getDevice());
    const mode = t ? 'reconnect' : 'pair';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}/ws?room=${r}&role=pc&mode=${mode}&deviceId=${d}`;
    if (t) url += `&token=${encodeURIComponent(t)}`;
    return url;
  }

  function authHeaders() {
    return { 'x-bridge-token': getToken(), 'x-bridge-role': 'pc', 'x-bridge-device': getDevice() };
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function stopPing() { if (pingInterval) { clearInterval(pingInterval); pingInterval = null; } }

  function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
    }, 30_000);
  }

  function connect() {
    const room = getRoom();
    if (!room) { log('Enter a room ID first', 'warn'); return; }
    localStorage.setItem(ROOM_KEY, room);
    roomDisplay.textContent = room;

    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    peerConnected = false;
    setPill(stPc, 'Connecting…', 'warn');
    setPill(stPhone, '—', '');

    log(`Connecting to room ${room} as PC…`);
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setPill(stPc, 'Connected', 'ok');
      log('WebSocket connected');
      startPing();
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        log(`Binary frame received: ${e.data.byteLength} bytes`);
        return;
      }
      let m;
      try { m = JSON.parse(e.data); } catch { log('Non-JSON: ' + e.data); return; }

      switch (m.t) {
        case 'device_token':
          localStorage.setItem(storageKey('token'), m.token);
          localStorage.setItem(storageKey('device'), m.deviceId);
          log('Pairing token saved (first pair)');
          break;

        case 'server_ready':
          log(`Server ready — role=${m.role} room=${m.room}`);
          break;

        case 'peer_connected':
          peerConnected = true;
          setPill(stPhone, 'Connected', 'ok');
          log('Phone connected');
          break;

        case 'peer_waiting':
          peerConnected = false;
          setPill(stPhone, 'Waiting…', 'warn');
          log('Waiting for phone…');
          break;

        case 'peer_disconnected':
          peerConnected = false;
          setPill(stPhone, 'Disconnected', '');
          log('Phone disconnected', 'warn');
          break;

        case 'peer_error':
          peerConnected = false;
          setPill(stPhone, 'Error', 'error');
          log('Phone connection error', 'error');
          break;

        case 'pair_error':
          log(`Pair error: ${m.reason || 'unknown'}`, 'error');
          setPill(stPc, 'Pair error', 'error');
          break;

        case 'pong':
          // keepalive confirmed — no UI action needed
          break;

        case 'backup_request':
          log(`Backup requested — jobId=${m.jobId}`);
          break;
        case 'backup_begin':
          log(`Backup started — jobId=${m.jobId} files=${m.fileCount}`);
          break;
        case 'backup_file':
          log(`File: ${m.path} (${m.size} bytes, ${m.chunkCount} chunks)`);
          break;
        case 'backup_chunk':
          log(`Chunk fileIdx=${m.fileIndex} chunkIdx=${m.chunkIndex} size=${m.chunkSize}`);
          break;
        case 'backup_end':
          log(`Backup transfer complete — jobId=${m.jobId}`);
          break;
        case 'backup_complete':
          log(`Backup confirmed by PC — jobId=${m.jobId}`);
          break;
        case 'backup_error':
          log(`Backup error: ${m.reason}`, 'error');
          break;

        case 'restore_begin':
          log(`Restore accepted by phone — jobId=${m.jobId}`);
          break;
        case 'restore_complete':
          log(`Restore complete on phone — jobId=${m.jobId}`);
          break;
        case 'restore_error':
          log(`Restore error: ${m.reason}`, 'error');
          break;

        default:
          log(`Server msg: ${JSON.stringify(m)}`);
      }
    };

    ws.onclose = (e) => {
      stopPing();
      peerConnected = false;
      setPill(stPc, 'Disconnected', '');
      setPill(stPhone, '—', '');
      log(`WebSocket closed (code=${e.code})`, 'warn');
    };

    ws.onerror = () => {
      log('WebSocket error. If this was an HTTP 409, clear/reset pairing for this room and pair intentionally.', 'error');
      setPill(stPc, 'Error', 'error');
    };
  }

  function disconnect() {
    stopPing();
    if (ws) ws.close(1000, 'User disconnect');
    setPill(stPc, 'Disconnected', '');
    setPill(stPhone, '—', '');
    log('Disconnected by user');
  }

  // ── Pairing reset ──────────────────────────────────────────────────────────
  async function resetPairing() {
    const t = getToken();
    if (!t) { log('No pairing token stored — nothing to reset', 'warn'); return; }
    const room = getRoom();
    try {
      const res = await fetch(`/api/pairing/reset?room=${encodeURIComponent(room)}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.ok) {
        localStorage.removeItem(storageKey('token'));
        disconnect();
        log('Pairing reset — token cleared locally and on server');
        setPill(stPc, 'Reset', '');
      } else {
        log(`Reset failed: ${data.error}`, 'error');
      }
    } catch (err) {
      log(`Reset error: ${err}`, 'error');
    }
  }

  // ── Test server ────────────────────────────────────────────────────────────
  async function testServer() {
    log('Testing server…');
    try {
      const res = await fetch('/health');
      const data = await res.json();
      if (data.ok) {
        setPill(stServer, 'Online', 'ok');
        log(`Server OK — ${data.websocket}`);
      } else {
        setPill(stServer, 'Error', 'error');
        log('Server health check failed', 'error');
      }
    } catch (err) {
      setPill(stServer, 'Offline', 'error');
      log(`Server unreachable: ${err}`, 'error');
    }
  }

  // ── Cloud Backups ──────────────────────────────────────────────────────────
  async function refreshBackups() {
    const t = getToken();
    if (!t) { log('Not paired — cannot list backups', 'warn'); return; }
    const room = encodeURIComponent(getRoom());
    log('Refreshing cloud backups…');
    try {
      const res = await fetch(`/api/backups/list?room=${room}`, { headers: authHeaders() });
      const data = await res.json();
      if (!data.ok) { log(`List error: ${data.error}`, 'error'); return; }
      backupList.innerHTML = '';
      if (!data.backups || data.backups.length === 0) {
        backupList.innerHTML = '<p class="empty">No cloud backups found.</p>';
        log('No cloud backups found');
        return;
      }
      log(`Found ${data.backups.length} backup(s)`);
      for (const b of data.backups) {
        const gb = (b.totalBytes / 1_073_741_824).toFixed(3);
        const date = new Date(b.createdAt).toLocaleString();
        const div = document.createElement('div');
        div.className = 'backup-entry';
        div.innerHTML = `
          <div class="backup-info">
            <b>${b.backupId}</b><br>
            <small>${date} · ${gb} GB · ${b.files.length} files</small>
          </div>
          <div class="backup-actions">
            <button class="small" data-action="download" data-id="${b.backupId}">DOWNLOAD</button>
            <button class="small danger" data-action="delete" data-id="${b.backupId}">DELETE</button>
          </div>`;
        backupList.appendChild(div);
      }
    } catch (err) {
      log(`Refresh error: ${err}`, 'error');
    }
  }

  async function downloadBackup(backupId) {
    log(`Downloading backup ${backupId}…`);
    const room = encodeURIComponent(getRoom());
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(backupId)}/manifest?room=${room}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!data.ok) { log(`Manifest error: ${data.error}`, 'error'); return; }
      log(`Manifest: ${data.manifest.files.length} files, ${data.manifest.totalBytes} bytes`);
      log('Note: Use the Windows PC app to download the full backup to disk.');
    } catch (err) {
      log(`Download error: ${err}`, 'error');
    }
  }

  async function deleteBackup(backupId) {
    if (!confirm(`Delete backup ${backupId}? This cannot be undone.`)) return;
    const room = encodeURIComponent(getRoom());
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(backupId)}?room=${room}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.ok) { log(`Backup ${backupId} deleted`); refreshBackups(); }
      else log(`Delete error: ${data.error}`, 'error');
    } catch (err) {
      log(`Delete error: ${err}`, 'error');
    }
  }

  // ── Request backup ─────────────────────────────────────────────────────────
  function requestBackup() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Not connected — connecting first…', 'warn');
      connect();
      return;
    }
    const jobId = crypto.randomUUID();
    ws.send(JSON.stringify({ t: 'backup_request', jobId }));
    log(`Backup requested — jobId=${jobId}`);
  }

  // ── Button wiring ──────────────────────────────────────────────────────────
  document.getElementById('btnConnect').onclick        = connect;
  document.getElementById('btnDisconnect').onclick     = disconnect;
  document.getElementById('btnResetPairing').onclick   = resetPairing;
  document.getElementById('btnTestServer').onclick     = testServer;
  document.getElementById('btnRefresh').onclick        = refreshBackups;
  document.getElementById('btnRequestBackup').onclick  = requestBackup;
  document.getElementById('btnClearLog').onclick       = () => { logEl.textContent = ''; };

  document.getElementById('btnNewRoom').onclick = () => {
    const r = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      b => b.toString(16).padStart(2, '0')).join('');
    roomInput.value = r;
    roomDisplay.textContent = r;
    localStorage.setItem(ROOM_KEY, r);
    localStorage.removeItem(storageKey('token', r));
    log(`New room ID: ${r}`);
  };

  // Backup list action delegation
  backupList.addEventListener('click', (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.target);
    if (btn.tagName !== 'BUTTON') return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === 'download') downloadBackup(id);
    if (action === 'delete') deleteBackup(id);
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  const savedRoom = localStorage.getItem(ROOM_KEY) || '24e30495a1ceeed42cdd2def95abcc2e';
  roomInput.value = savedRoom;
  roomDisplay.textContent = savedRoom;

  testServer();
})();
