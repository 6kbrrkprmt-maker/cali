import { Room, RoomEvent, Track } from 'https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.esm.mjs';

const state = {
  token: localStorage.getItem('platformToken') || '',
  bridgeSessionId: '',
  room: null,
};

const authPanel = document.getElementById('authPanel');
const stage = document.getElementById('stage');
const loginStatus = document.getElementById('loginStatus');
const streamStatus = document.getElementById('streamStatus');
const roomName = document.getElementById('roomName');
const remoteVideo = document.getElementById('remoteVideo');
const placeholder = document.getElementById('placeholder');

function getApiBase() {
  return window.location.origin.replace(/\/$/, '');
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${getApiBase()}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function login(account, password) {
  loginStatus.textContent = '登入中';
  const data = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });

  state.token = data.accessToken;
  localStorage.setItem('platformToken', state.token);
  await startPocSession();
}

async function startPocSession() {
  loginStatus.textContent = '建立 Bridge session';
  const session = await request('/api/v1/bridge/sessions/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'calibet' }),
  });

  state.bridgeSessionId = session.bridgeSessionId;
  loginStatus.textContent = '取得 LiveKit token';
  const liveKit = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/livekit-token`);

  authPanel.hidden = true;
  stage.hidden = false;
  roomName.textContent = liveKit.room;
  streamStatus.textContent = '連線 LiveKit';

  await connectLiveKit(liveKit.url, liveKit.token);
}

function attachVideoTrack(track) {
  if (!track || track.kind !== Track.Kind.Video) {
    return false;
  }

  track.attach(remoteVideo);
  placeholder.classList.add('hidden');
  streamStatus.textContent = '正在播放串流';
  return true;
}

function attachPublishedVideoTracks(room) {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (attachVideoTrack(publication.track)) {
        return true;
      }
    }
  }

  return false;
}

async function connectLiveKit(url, token) {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  state.room = room;

  room.on(RoomEvent.Connected, () => {
    streamStatus.textContent = '已連上，等待 Worker 畫面';
  });

  room.on(RoomEvent.Disconnected, () => {
    streamStatus.textContent = 'LiveKit 已斷線';
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    attachVideoTrack(track);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach();
    placeholder.classList.remove('hidden');
    streamStatus.textContent = '串流暫停';
  });

  await room.connect(url, token);
  attachPublishedVideoTracks(room);
}

async function sendInput(action) {
  if (!state.bridgeSessionId) {
    return;
  }

  await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
}

remoteVideo.addEventListener('click', (event) => {
  const rect = remoteVideo.getBoundingClientRect();
  sendInput({
    type: 'click',
    xRatio: (event.clientX - rect.left) / rect.width,
    yRatio: (event.clientY - rect.top) / rect.height,
    button: 'left',
    clickCount: 1,
  }).catch(() => {
    streamStatus.textContent = '操作送出失敗';
  });
});

document.getElementById('loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  login(
    document.getElementById('account').value.trim(),
    document.getElementById('password').value,
  ).catch((error) => {
    loginStatus.textContent = error.message;
  });
});

if (state.token) {
  startPocSession().catch((error) => {
    localStorage.removeItem('platformToken');
    state.token = '';
    loginStatus.textContent = error.message;
  });
}