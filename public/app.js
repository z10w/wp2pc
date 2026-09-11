(() => {
  const httpsBase = `${location.protocol}//${location.host}`;
  const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

  const $ = (id) => document.getElementById(id);
  $('baseUrl').textContent = httpsBase;
  $('wsUrl').textContent = wsBase;
  $('endpointLarge').textContent = wsBase;

  function setStatus(kind, text) {
    const pill = $('statusPill');
    pill.className = `pill ${kind}`;
    pill.textContent = text;
  }

  function roomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function log(line) {
    const el = $('log');
    el.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function newRoom() {
    $('room').value = roomCode();
  }
  newRoom();
  $('newRoom').addEventListener('click', newRoom);

  async function health() {
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('Health check failed');
      $('healthText').textContent = 'Online';
      setStatus('ok', 'ONLINE');
    } catch (error) {
      $('healthText').textContent = 'Unavailable';
      setStatus('bad', 'OFFLINE');
      log(`Health error: ${error.message}`);
    }
  }

  $('connect').addEventListener('click', () => {
    const room = $('room').value.trim();
    if (room.length < 8) {
      log('Room must be at least 8 characters.');
      return;
    }
    const url = `${wsBase}?room=${encodeURIComponent(room)}&role=pc&mode=pair`;
    log(`Connecting to ${url}`);
    const socket = new WebSocket(url);
    $('connect').disabled = true;

    socket.addEventListener('open', () => log('WebSocket connected.'));
    socket.addEventListener('message', event => log(`Received: ${event.data}`));
    socket.addEventListener('close', event => {
      log(`WebSocket closed (${event.code}).`);
      $('connect').disabled = false;
    });
    socket.addEventListener('error', () => {
      log('WebSocket error.');
      $('connect').disabled = false;
    });
  });

  health();
})();
