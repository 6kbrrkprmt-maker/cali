const state = {
  token: localStorage.getItem('platformToken') || '',
  bridgeSessionId: '',
  room: null,
  lastSentAt: 0,
  statusPulseTimer: null,
};

let liveKitModulePromise;

const statusEl = document.getElementById('status');
const screenEl = document.getElementById('screen');
const screenWrap = document.querySelector('.screen-wrap');

function setStatus(message) {
  statusEl.textContent = message;
}

function pulseStatus() {
  statusEl.classList.add('active');
  if (state.statusPulseTimer) {
    clearTimeout(state.statusPulseTimer);
  }

  state.statusPulseTimer = setTimeout(() => {
    statusEl.classList.remove('active');
    state.statusPulseTimer = null;
  }, 280);
}

function showTapFeedback(xRatio, yRatio) {
  if (!screenWrap) {
    return;
  }

  const dot = document.createElement('span');
  dot.className = 'input-feedback-dot';
  dot.style.left = `${Math.max(0, Math.min(1, xRatio)) * 100}%`;
  dot.style.top = `${Math.max(0, Math.min(1, yRatio)) * 100}%`;
  screenWrap.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
  setTimeout(() => dot.remove(), 900);
}

function getApiBase() {
  return document.getElementById('apiBase').value.trim().replace(/\/$/, '');
}

async function request(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

async function getLiveKitModule() {
  if (!liveKitModulePromise) {
    liveKitModulePromise = import('https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.esm.mjs');
  }
  return liveKitModulePromise;
}

function attachVideoTrack(track) {
  if (!track) {
    return false;
  }

  track.attach(screenEl);
  screenEl.play().catch(() => undefined);
  return true;
}

function attachPublishedTracks(room) {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind !== 'video') {
        continue;
      }

      if (!publication.isSubscribed) {
        publication.setSubscribed(true);
      }

      if (publication.track) {
        return attachVideoTrack(publication.track);
      }
    }
  }

  return false;
}

async function connectLiveKit(url, token) {
  const { Room, RoomEvent, Track } = await getLiveKitModule();
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
  });

  state.room = room;

  room.on(RoomEvent.Connected, () => {
    setStatus(`${statusEl.textContent.split('\n').slice(0, 3).join('\n')}\nLiveKit 已連線`);
  });

  room.on(RoomEvent.Disconnected, () => {
    setStatus(`${statusEl.textContent.split('\n').slice(0, 3).join('\n')}\nLiveKit 已斷線`);
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Video) {
      return;
    }

    attachVideoTrack(track);
    setStatus(`${statusEl.textContent.split('\n').slice(0, 3).join('\n')}\n正在播放串流`);
  });

  room.on(RoomEvent.TrackPublished, (publication) => {
    if (publication.kind !== Track.Kind.Video) {
      return;
    }

    publication.setSubscribed(true);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Video) {
      track.detach();
    }
  });

  await room.connect(url, token, { autoSubscribe: true });
  attachPublishedTracks(room);
}

async function login() {
  const account = document.getElementById('account').value.trim();
  const password = document.getElementById('password').value;

  if (!account || !password) {
    setStatus('請輸入帳號與密碼');
    return;
  }

  setStatus('登入中...');
  try {
    const data = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
    state.token = data.accessToken;
    localStorage.setItem('platformToken', state.token);
    setStatus(`登入成功\naccount: ${data.user.account}\nrole: ${data.user.role}`);
  } catch (err) {
    setStatus(`登入失敗\n${err.message}`);
  }
}

async function startBridge() {
  if (!state.token) {
    setStatus('請先登入');
    return;
  }

  setStatus('建立 bridge session...');
  try {
    if (state.room) {
      state.room.disconnect();
      state.room = null;
    }

    const data = await request('/api/v1/bridge/sessions/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'calibet' }),
    });

    state.bridgeSessionId = data.bridgeSessionId;
    setStatus(
      `Bridge 啟動成功\nbridgeSessionId: ${data.bridgeSessionId}\nworkerSessionId: ${data.workerSessionId}`,
    );

    const liveKit = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/livekit-token`);
    await connectLiveKit(liveKit.url, liveKit.token);
  } catch (err) {
    setStatus(`Bridge 啟動失敗\n${err.message}`);
  }
}

async function sendInput(action) {
  if (!state.bridgeSessionId) {
    return;
  }

  const now = Date.now();
  if (now - state.lastSentAt < 40) {
    return;
  }
  state.lastSentAt = now;
  pulseStatus();

  try {
    await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
  } catch (err) {
    setStatus(`操作發送失敗\n${err.message}`);
  }
}

function openRecordsPage() {
  window.open('/records.html', '_blank');
}

function isRecordAreaClick(xRatio, yRatio) {
  return xRatio >= 0.76 && yRatio <= 0.15;
}

screenEl.addEventListener('click', (event) => {
  const rect = screenEl.getBoundingClientRect();
  const xRatio = (event.clientX - rect.left) / rect.width;
  const yRatio = (event.clientY - rect.top) / rect.height;

  if (isRecordAreaClick(xRatio, yRatio)) {
    openRecordsPage();
    setStatus(`${statusEl.textContent.split('\n').slice(0, 3).join('\n')}\n已攔截紀錄入口，開啟本站紀錄`);
    return;
  }

  showTapFeedback(xRatio, yRatio);

  sendInput({
    type: 'click',
    xRatio,
    yRatio,
    button: 'left',
    clickCount: 1,
  });
});

window.addEventListener('keydown', (event) => {
  if (!state.bridgeSessionId) {
    return;
  }

  const ignored = ['F5', 'F12'];
  if (ignored.includes(event.key)) {
    return;
  }

  let key = event.key;
  if (event.key === ' ') {
    key = 'Space';
  }

  sendInput({
    type: 'key',
    key,
  });
});

screenEl.addEventListener('wheel', (event) => {
  if (!state.bridgeSessionId) {
    return;
  }

  event.preventDefault();
  sendInput({
    type: 'scroll',
    deltaY: Math.round(event.deltaY),
  });
}, { passive: false });

document.getElementById('btnLogin').addEventListener('click', login);
document.getElementById('btnStart').addEventListener('click', startBridge);
document.getElementById('btnRecords').addEventListener('click', () => {
  openRecordsPage();
});
document.getElementById('recordsOverlay').addEventListener('click', (event) => {
  event.stopPropagation();
  openRecordsPage();
});

if (state.token) {
  setStatus('已載入平台 token，可直接啟動 Bridge 或開啟本站紀錄');
}
