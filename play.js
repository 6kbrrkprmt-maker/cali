const state = {
  token: localStorage.getItem('platformToken') || '',
  bridgeSessionId: '',
  room: null,
  lastSentAt: 0,
  lastPointerActionAt: 0,
  frameSeen: false,
  recordsOpen: false,
  topbarPulseTimer: null,
  connectWatchdogTimer: null,
  inputAckTimer: null,
  framePollTimer: null,
  framePollErrors: 0,
  frameFetchInProgress: false,
  idleShutdownTimer: null,
  closingSession: false,
};

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

let liveKitModulePromise;

const appShell = document.querySelector('.app-shell');
const screenEl = document.getElementById('screen');
const frameScreenEl = document.getElementById('frameScreen');
const screenFrame = document.querySelector('.screen-frame');
const loadingLayer = document.getElementById('loadingLayer');
const loadingTitle = document.getElementById('loadingTitle');
const loadingText = document.getElementById('loadingText');
const sessionState = document.getElementById('sessionState');
const loginStatus = document.getElementById('loginStatus');
const gameTopbar = document.querySelector('.game-topbar');

function getApiBase() {
  return `${window.location.origin}`.replace(/\/$/, '');
}

function setLoginStatus(text) {
  loginStatus.textContent = text;
}

function setSessionState(text) {
  sessionState.textContent = text;
}

function showLoading(title, text) {
  loadingTitle.textContent = title;
  loadingText.textContent = text;
  loadingLayer.classList.remove('hidden');
}

function pulseInputState() {
  if (!gameTopbar) {
    return;
  }

  gameTopbar.classList.add('input-active');
  if (state.topbarPulseTimer) {
    clearTimeout(state.topbarPulseTimer);
  }

  state.topbarPulseTimer = setTimeout(() => {
    gameTopbar.classList.remove('input-active');
    state.topbarPulseTimer = null;
  }, 280);
}

function showTapFeedback(xRatio, yRatio) {
  if (!screenFrame) {
    return;
  }

  const dot = document.createElement('span');
  dot.className = 'input-feedback-dot';
  dot.style.left = `${Math.max(0, Math.min(1, xRatio)) * 100}%`;
  dot.style.top = `${Math.max(0, Math.min(1, yRatio)) * 100}%`;
  screenFrame.appendChild(dot);

  dot.addEventListener('animationend', () => {
    dot.remove();
  }, { once: true });
  setTimeout(() => dot.remove(), 900);
}

function hideLoading() {
  loadingLayer.classList.add('hidden');
}

function stopFramePolling() {
  if (state.framePollTimer) {
    clearInterval(state.framePollTimer);
    state.framePollTimer = null;
  }
}

async function fetchFrame() {
  if (!state.bridgeSessionId || state.frameFetchInProgress) {
    return;
  }

  state.frameFetchInProgress = true;
  try {
    const frame = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/frame`);
    frameScreenEl.src = `data:${frame.mimeType || 'image/jpeg'};base64,${frame.imageBase64}`;
    frameScreenEl.hidden = false;
    screenEl.hidden = true;
    state.frameSeen = true;
    state.framePollErrors = 0;
    hideLoading();
    setSessionState('已連線');
  } catch (_error) {
    state.framePollErrors += 1;
    if (state.framePollErrors >= 3) {
      showLoading('等待畫面', '正在重新取得 Worker 畫面');
      setSessionState('等待畫面');
    }
  } finally {
    state.frameFetchInProgress = false;
  }
}

function startFramePolling() {
  stopFramePolling();
  screenEl.hidden = true;
  frameScreenEl.hidden = false;
  setSessionState('已連線 · 本機畫面模式');
  fetchFrame().catch(() => undefined);
  state.framePollTimer = setInterval(() => {
    fetchFrame().catch(() => undefined);
  }, 100);
}

function clearIdleShutdown() {
  if (state.idleShutdownTimer) {
    clearTimeout(state.idleShutdownTimer);
    state.idleShutdownTimer = null;
  }
}

function scheduleIdleShutdown() {
  clearIdleShutdown();
  if (!state.bridgeSessionId) {
    return;
  }

  state.idleShutdownTimer = setTimeout(() => {
    closeBridgeSession({ reason: 'idle' }).catch(() => undefined);
  }, IDLE_SHUTDOWN_MS);
}

async function closeBridgeSession(options = {}) {
  const bridgeSessionId = state.bridgeSessionId;
  const token = state.token;
  if (!bridgeSessionId || !token || state.closingSession) {
    return;
  }

  state.closingSession = true;
  clearIdleShutdown();
  clearConnectWatchdog();
  stopFramePolling();
  if (state.room) {
    state.room.disconnect();
    state.room = null;
  }

  state.bridgeSessionId = '';
  screenEl.srcObject = null;
  const closeRequest = fetch(`${getApiBase()}/api/v1/bridge/sessions/${bridgeSessionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    keepalive: Boolean(options.keepalive),
  }).catch(() => undefined);

  if (!options.keepalive) {
    await closeRequest;
  }

  if (options.reason === 'idle') {
    screenEl.hidden = false;
    frameScreenEl.hidden = true;
    appShell.dataset.state = 'login';
    setLoginStatus('閒置已關閉，已停止串流');
  }

  state.closingSession = false;
}

function showInputAck() {
  if (!sessionState.textContent?.startsWith('已連線')) {
    return;
  }

  setSessionState('已連線 · 操作已送出');
  if (state.inputAckTimer) {
    clearTimeout(state.inputAckTimer);
  }
  state.inputAckTimer = setTimeout(() => {
    if (sessionState.textContent?.startsWith('已連線')) {
      setSessionState('已連線');
    }
    state.inputAckTimer = null;
  }, 550);
}

function clearConnectWatchdog() {
  if (state.connectWatchdogTimer) {
    clearTimeout(state.connectWatchdogTimer);
    state.connectWatchdogTimer = null;
  }
}

async function request(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${getApiBase()}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
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
  if (!state.frameSeen) {
    state.frameSeen = true;
    hideLoading();
  }
  setSessionState('已連線');
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
  stopFramePolling();
  screenEl.hidden = false;
  frameScreenEl.hidden = true;
  const { Room, RoomEvent, Track } = await getLiveKitModule();
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
  });

  state.room = room;

  room.on(RoomEvent.Connected, () => {
    setSessionState('已連上，等待畫面');
    clearConnectWatchdog();
    state.connectWatchdogTimer = setTimeout(() => {
      if (!state.frameSeen) {
        hideLoading();
      }
      state.connectWatchdogTimer = null;
    }, 6000);
  });

  room.on(RoomEvent.Disconnected, () => {
    clearConnectWatchdog();
    setSessionState('串流斷線');
    state.frameSeen = false;
    showLoading('串流斷線', '請重新登入或重試');
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Video) {
      return;
    }
    attachVideoTrack(track);
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
      state.frameSeen = false;
      showLoading('等待串流', '等待 Worker 畫面');
    }
  });

  await room.connect(url, token, { autoSubscribe: true });
  attachPublishedTracks(room);
}

async function login(account, password) {
  setLoginStatus('登入中');
  const data = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });

  state.token = data.accessToken;
  localStorage.setItem('platformToken', state.token);
  setLoginStatus('登入成功');
  await enterGame();
}

async function enterGame() {
  if (!state.token) {
    return;
  }

  appShell.dataset.state = 'game';
  showLoading('正在連線', '正在進入遊戲大廳');
  setSessionState('連線中');
  state.frameSeen = false;
  clearConnectWatchdog();
  state.connectWatchdogTimer = setTimeout(() => {
    hideLoading();
    state.connectWatchdogTimer = null;
  }, 12000);

  if (state.room) {
    state.room.disconnect();
    state.room = null;
  }

  const data = await request('/api/v1/bridge/sessions/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'calibet', streamMode: 'livekit' }),
  });

  state.bridgeSessionId = data.bridgeSessionId;
  scheduleIdleShutdown();

  if (data.streamMode === 'frame') {
    startFramePolling();
    return;
  }

  try {
    const liveKit = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/livekit-token`);
    await connectLiveKit(liveKit.url, liveKit.token);
  } catch (_error) {
    startFramePolling();
  }
}

async function sendInput(action) {
  if (!state.bridgeSessionId) {
    return;
  }

  const now = Date.now();
  if (now - state.lastSentAt < 35) {
    return;
  }
  state.lastSentAt = now;
  scheduleIdleShutdown();
  pulseInputState();

  try {
    await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
    showInputAck();
    if (frameScreenEl && !frameScreenEl.hidden) {
      fetchFrame().catch(() => undefined);
    }
  } catch (error) {
    setSessionState('操作失敗');
  }
}

async function openRecordsModal() {
  if (!state.bridgeSessionId) {
    return;
  }

  state.recordsOpen = true;
  const modal = document.getElementById('recordsModal');
  const frame = document.getElementById('recordsFrame');

  setSessionState('同步紀錄中');
  try {
    const result = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/sync-records`, {
      method: 'POST',
    });
    if (result?.inserted?.total > 0) {
      setSessionState(`已連線 · 新增 ${result.inserted.total} 筆紀錄`);
    } else {
      setSessionState('已連線');
    }
  } catch (_error) {
    setSessionState('同步失敗');
  }

  if (frame.getAttribute('src') !== '/records.html?embedded=1') {
    frame.src = '/records.html?embedded=1';
  } else {
    frame.contentWindow?.location.reload();
  }
  modal.hidden = false;
}

function closeRecordsModal() {
  state.recordsOpen = false;
  document.getElementById('recordsModal').hidden = true;
}

function isRecordAreaClick(xRatio, yRatio) {
  return xRatio >= 0.76 && yRatio <= 0.15;
}

function getActiveScreenElement() {
  return frameScreenEl && !frameScreenEl.hidden ? frameScreenEl : screenEl;
}

function handleStageClick(clientX, clientY) {
  const rect = getActiveScreenElement().getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const xRatio = (clientX - rect.left) / rect.width;
  const yRatio = (clientY - rect.top) / rect.height;

  if (isRecordAreaClick(xRatio, yRatio)) {
    openRecordsModal().catch(() => undefined);
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
}

function handleStagePointerUp(event) {
  if (event.target === document.getElementById('recordsHotspot')) {
    return;
  }

  state.lastPointerActionAt = Date.now();
  handleStageClick(event.clientX, event.clientY);
}

screenFrame?.addEventListener('click', (event) => {
  if (event.target === document.getElementById('recordsHotspot')) {
    return;
  }

  if (Date.now() - state.lastPointerActionAt < 220) {
    return;
  }

  handleStageClick(event.clientX, event.clientY);
}, true);

screenFrame?.addEventListener('pointerup', (event) => {
  if (!event.isPrimary) {
    return;
  }

  handleStagePointerUp(event);
}, true);

screenEl.addEventListener('wheel', (event) => {
  if (!state.bridgeSessionId) {
    return;
  }

  event.preventDefault();
  scheduleIdleShutdown();
  sendInput({
    type: 'scroll',
    deltaY: Math.round(event.deltaY),
  });
}, { passive: false });

window.addEventListener('keydown', (event) => {
  if (state.recordsOpen) {
    if (event.key === 'Escape') {
      closeRecordsModal();
    }
    return;
  }

  if (!state.bridgeSessionId) {
    return;
  }

  if (['F5', 'F12'].includes(event.key)) {
    return;
  }

  scheduleIdleShutdown();
  sendInput({
    type: 'key',
    key: event.key === ' ' ? 'Space' : event.key,
  });
});

document.getElementById('loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  login(
    document.getElementById('account').value.trim(),
    document.getElementById('password').value,
  ).catch((error) => setLoginStatus(error.message));
});

document.getElementById('recordsBtn').addEventListener('click', () => {
  openRecordsModal().catch(() => undefined);
});
document.getElementById('recordsHotspot').addEventListener('click', (event) => {
  event.stopPropagation();
  openRecordsModal().catch(() => undefined);
});
document.getElementById('closeRecordsBtn').addEventListener('click', closeRecordsModal);
document.getElementById('recordsModal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closeRecordsModal();
  }
});
document.getElementById('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => undefined);
    return;
  }
  document.exitFullscreen().catch(() => undefined);
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await closeBridgeSession();
  localStorage.removeItem('platformToken');
  state.token = '';
  if (state.inputAckTimer) {
    clearTimeout(state.inputAckTimer);
    state.inputAckTimer = null;
  }
  screenEl.srcObject = null;
  screenEl.hidden = false;
  frameScreenEl.hidden = true;
  appShell.dataset.state = 'login';
  setLoginStatus('已登出');
});

window.addEventListener('pagehide', () => {
  closeBridgeSession({ keepalive: true }).catch(() => undefined);
});

if (state.token) {
  enterGame().catch((error) => {
    localStorage.removeItem('platformToken');
    state.token = '';
    appShell.dataset.state = 'login';
    setLoginStatus(error.message);
  });
}
