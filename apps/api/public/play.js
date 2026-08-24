const state = {
  view: 'hall',
  selectedTable: null,
  bridgeSessionId: '',
  room: null,
  lastSentAt: 0,
  lastPointerActionAt: 0,
  frameSeen: false,
  recordsOpen: false,
  recordsFromHall: false,
  topbarPulseTimer: null,
  connectWatchdogTimer: null,
  inputAckTimer: null,
  framePollTimer: null,
  framePlaybackTimer: null,
  framePlaybackQueue: [],
  outcomePollTimer: null,
  outcomePollErrors: 0,
  lastOutcomeLogId: 0,
  framePollErrors: 0,
  frameFetchInProgress: false,
  idleShutdownTimer: null,
  closingSession: false,
  selectedChip: 100,
  baccarat: {
    balance: 0,
    roundId: '',
    totals: { player: 0, banker: 0, tie: 0 },
  },
};

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const FRAME_PLAYBACK_DELAY_MS = 3 * 1000;
const LOCAL_BACCARAT_KEY = 'calibetLocalBaccaratState';

let liveKitModulePromise;
let tableStatusTimer;
const appliedOutcomeDetectionKeys = new Set();

const appShell = document.querySelector('.app-shell');
const hallPanel = document.getElementById('hallPanel');
const caliHallFrame = document.getElementById('caliHallFrame');
const caliTableFrame = document.getElementById('caliTableFrame');
const caliLiveFrame = document.getElementById('caliLiveFrame');
const screenEl = document.getElementById('screen');
const frameScreenEl = document.getElementById('frameScreen');
const screenFrame = document.querySelector('.screen-frame');
const loadingLayer = document.getElementById('loadingLayer');
const loadingTitle = document.getElementById('loadingTitle');
const loadingText = document.getElementById('loadingText');
const sessionState = document.getElementById('sessionState');
const tableActionStatus = document.getElementById('tableActionStatus');
const tableSystemLayer = document.querySelector('.table-system-layer');
const gameTopbar = document.querySelector('.game-topbar');
const baccaratPanel = document.getElementById('baccaratPanel');
const baccaratBalance = document.getElementById('baccaratBalance');
const baccaratRound = document.getElementById('baccaratRound');
const baccaratMessage = document.getElementById('baccaratMessage');
const hallAccount = document.getElementById('hallAccount');
const hallBalance = document.getElementById('hallBalance');
const hallRange = document.getElementById('hallRange');
const tableSelectedChip = document.getElementById('tableSelectedChip');
const tablePlayerBet = document.getElementById('tablePlayerBet');
const tableTieBet = document.getElementById('tableTieBet');
const tableBankerBet = document.getElementById('tableBankerBet');

function getApiBase() {
  return `${window.location.origin}`.replace(/\/$/, '');
}

function setSessionState(text) {
  sessionState.textContent = text;
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}

function createLocalBaccaratState() {
  return {
    balance: 4191.6,
    round: { id: `LOCAL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}` },
    totals: { player: 0, banker: 0, tie: 0 },
  };
}

function readLocalBaccaratState() {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_BACCARAT_KEY) || 'null');
    if (stored?.round?.id && stored?.totals) {
      return stored;
    }
  } catch (_error) {
    // Fall back to a fresh local table state when storage is unavailable or corrupt.
  }
  return createLocalBaccaratState();
}

function writeLocalBaccaratState(localState) {
  localStorage.setItem(LOCAL_BACCARAT_KEY, JSON.stringify(localState));
  return localState;
}

function isApiUnavailable(error) {
  return /HTTP 404|Failed to fetch|NetworkError/i.test(error?.message || '');
}

function getConfiguredCaliTableUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawUrl = params.get('tableUrl') || localStorage.getItem('caliTableUrl') || '';
  if (!rawUrl) {
    return '';
  }

  try {
    const url = new URL(rawUrl, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_error) {
    return '';
  }
}

function getPreferredBridgeStreamMode() {
  const params = new URLSearchParams(window.location.search);
  const configured = (params.get('streamMode') || localStorage.getItem('caliBridgeStreamMode') || 'livekit').toLowerCase();
  return configured === 'livekit' ? 'livekit' : 'frame';
}

function applyCaliLiveFrame() {
  if (!caliLiveFrame) {
    return false;
  }

  const tableUrl = getConfiguredCaliTableUrl();
  if (!tableUrl) {
    caliLiveFrame.hidden = true;
    caliLiveFrame.removeAttribute('src');
    appShell.dataset.live = 'missing';
    return false;
  }

  if (caliLiveFrame.getAttribute('src') !== tableUrl) {
    caliLiveFrame.src = tableUrl;
  }
  caliLiveFrame.hidden = false;
  appShell.dataset.live = 'cali';
  return true;
}

function showTableStatus(message) {
  if (!tableActionStatus) {
    return;
  }

  tableActionStatus.textContent = message;
  tableActionStatus.classList.add('show');
  if (tableStatusTimer) {
    clearTimeout(tableStatusTimer);
  }
  tableStatusTimer = setTimeout(() => {
    tableActionStatus.classList.remove('show');
    tableStatusTimer = null;
  }, 1400);
}

function renderLocalLedger() {
  if (tableSelectedChip) {
    tableSelectedChip.textContent = formatMoney(state.selectedChip);
  }
  if (tablePlayerBet) {
    tablePlayerBet.textContent = formatMoney(state.baccarat.totals.player);
  }
  if (tableTieBet) {
    tableTieBet.textContent = formatMoney(state.baccarat.totals.tie);
  }
  if (tableBankerBet) {
    tableBankerBet.textContent = formatMoney(state.baccarat.totals.banker);
  }
}

function getStoredAccount() {
  const token = localStorage.getItem('platformToken');
  if (!token) {
    return '23mzf';
  }

  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.account || '23mzf';
  } catch (_error) {
    return '23mzf';
  }
}

function setView(view) {
  state.view = view;
  appShell.dataset.state = view;
}

function replaceTextInFrame(documentRoot, label, value) {
  const walker = documentRoot.createTreeWalker(documentRoot.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue.includes(label)) {
      node.nodeValue = node.nodeValue.replace(new RegExp(`${label}[^\\s]*`), `${label}${value}`);
      return true;
    }
    node = walker.nextNode();
  }
  return false;
}

function patchCaliHallFrame(status) {
  if (!caliHallFrame?.contentDocument?.body) {
    return;
  }

  const frameDocument = caliHallFrame.contentDocument;
  applyCaliHallScale(frameDocument);
  replaceTextInFrame(frameDocument, 'ID:', getStoredAccount());
  replaceTextInFrame(frameDocument, '餘額', formatMoney(status?.balance ?? state.baccarat.balance));
  replaceTextInFrame(frameDocument, '限紅', '5 - 3,000');
}

function patchCaliTableFrame(status) {
  if (!caliTableFrame?.contentDocument?.body) {
    return;
  }

  const frameDocument = caliTableFrame.contentDocument;
  applyCaliTableScale(frameDocument);
  replaceTextInFrame(frameDocument, 'ID:', getStoredAccount());
  replaceTextInFrame(frameDocument, '餘額', formatMoney(status?.balance ?? state.baccarat.balance));
  replaceTextInFrame(frameDocument, '限紅', '5 - 3,000');
}

function applyCaliFrameScale(frameElement, frameDocument = frameElement?.contentDocument) {
  const app = frameDocument?.getElementById('app');
  if (!app || !frameElement) {
    return;
  }

  const scale = Math.min(frameElement.clientWidth / 1832, frameElement.clientHeight / 1080);
  app.style.width = '1832px';
  app.style.height = '1080px';
  app.style.position = 'absolute';
  app.style.top = '0';
  app.style.left = '0';
  app.style.transformOrigin = '0 0';
  app.style.transform = `scale(${scale})`;
  frameDocument.documentElement.style.width = '100%';
  frameDocument.documentElement.style.height = '100%';
  frameDocument.documentElement.style.overflow = 'hidden';
  frameDocument.body.style.width = '100%';
  frameDocument.body.style.height = '100%';
  frameDocument.body.style.margin = '0';
  frameDocument.body.style.overflow = 'hidden';
  frameDocument.body.style.background = '#000';
}

function applyCaliHallScale(frameDocument = caliHallFrame?.contentDocument) {
  applyCaliFrameScale(caliHallFrame, frameDocument);
}

function applyCaliTableScale(frameDocument = caliTableFrame?.contentDocument) {
  applyCaliFrameScale(caliTableFrame, frameDocument);
}

function getCaliHallDesignPoint(event) {
  if (!caliHallFrame) {
    return null;
  }

  const scale = Math.min(caliHallFrame.clientWidth / 1832, caliHallFrame.clientHeight / 1080);
  if (!scale) {
    return null;
  }

  return {
    x: event.clientX / scale,
    y: event.clientY / scale,
  };
}

function getCaliHallAction(point) {
  if (!point) {
    return null;
  }

  const { x, y } = point;
  if (y <= 55 && x >= 1090 && x <= 1155) {
    return { type: 'records' };
  }
  if (y <= 55 && x >= 1350 && x <= 1425) {
    return { type: 'fullscreen' };
  }
  if (y >= 54 && y <= 175 && x >= 155) {
    return { type: 'table', tableId: 'B601' };
  }

  const tableAreas = [
    { tableId: 'B601', left: 155, top: 185, right: 970, bottom: 400 },
    { tableId: 'D201', left: 985, top: 185, right: 1815, bottom: 400 },
    { tableId: 'P201', left: 155, top: 410, right: 970, bottom: 615 },
    { tableId: 'P202', left: 985, top: 410, right: 1815, bottom: 615 },
    { tableId: 'B501', left: 155, top: 625, right: 970, bottom: 825 },
  ];
  const area = tableAreas.find((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  if (area) {
    return { type: 'table', tableId: area.tableId };
  }

  return null;
}

function runCaliHallAction(action) {
  if (!action) {
    return false;
  }

  if (action.type === 'table') {
    enterSelectedTable(action.tableId);
    return true;
  }

  if (action.type === 'records') {
    state.recordsFromHall = true;
    setView('table');
    openRecordsModal().catch(() => undefined);
    return true;
  }

  if (action.type === 'fullscreen') {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
    return true;
  }

  return false;
}

function attachCaliHallControls() {
  const frameDocument = caliHallFrame?.contentDocument;
  if (!frameDocument?.body || frameDocument.body.dataset.controlsAttached === '1') {
    return;
  }

  frameDocument.body.dataset.controlsAttached = '1';
  frameDocument.addEventListener('click', (event) => {
    const action = getCaliHallAction(getCaliHallDesignPoint(event));
    if (!runCaliHallAction(action)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function getCaliTableDesignPoint(event) {
  const targetFrame = caliTableFrame || tableSystemLayer || event.currentTarget;
  if (!targetFrame) {
    return null;
  }

  const rect = targetFrame.getBoundingClientRect();
  const scale = Math.min(rect.width / 1832, rect.height / 1080);
  if (!scale) {
    return null;
  }

  return {
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale,
  };
}

function getCaliTableAction(point) {
  if (!point) {
    return null;
  }

  const { x, y } = point;
  if (x <= 155 && y <= 170) {
    return { type: 'back' };
  }
  if (y <= 55 && x >= 1090 && x <= 1155) {
    return { type: 'records' };
  }
  if (y <= 55 && x >= 1350 && x <= 1425) {
    return { type: 'fullscreen' };
  }

  const chipAreas = [
    { amount: 100, left: 1370, right: 1455 },
    { amount: 500, left: 1456, right: 1535 },
    { amount: 1000, left: 1536, right: 1618 },
    { amount: 3000, left: 1619, right: 1705 },
    { amount: 10000, left: 1706, right: 1815 },
  ];
  if (y >= 880 && y <= 1025) {
    const chip = chipAreas.find((area) => x >= area.left && x <= area.right);
    if (chip) {
      return { type: 'chip', amount: chip.amount };
    }
  }

  if (y >= 610 && y <= 800) {
    if (x >= 680 && x < 885) {
      return { type: 'bet', side: 'player' };
    }
    if (x >= 885 && x < 1090) {
      return { type: 'bet', side: 'tie' };
    }
    if (x >= 1090 && x <= 1305) {
      return { type: 'bet', side: 'banker' };
    }
  }

  return null;
}

function setSelectedChip(amount) {
  state.selectedChip = Number(amount || 100);
  document.querySelectorAll('[data-chip]').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.chip || 0) === state.selectedChip);
  });
  baccaratMessage.textContent = `已選 ${formatMoney(state.selectedChip)}`;
  renderLocalLedger();
  showTableStatus(`已選 ${formatMoney(state.selectedChip)}`);
}

function runCaliTableAction(action) {
  if (!action) {
    showTableStatus('請點籌碼或下注區');
    return false;
  }

  if (action.type === 'back') {
    returnToHall().catch(() => undefined);
    return true;
  }

  if (action.type === 'records') {
    openRecordsModal().catch(() => undefined);
    return true;
  }

  if (action.type === 'fullscreen') {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      document.exitFullscreen().catch(() => undefined);
    }
    return true;
  }

  if (action.type === 'chip') {
    setSelectedChip(action.amount);
    return true;
  }

  if (action.type === 'bet') {
    placeBaccaratBet(action.side).catch(() => undefined);
    return true;
  }

  return false;
}

function attachCaliTableControls() {
  const frameDocument = caliTableFrame?.contentDocument;
  if (!frameDocument?.body || frameDocument.body.dataset.controlsAttached === '1') {
    return;
  }

  frameDocument.body.dataset.controlsAttached = '1';
  const handleTableInput = (event) => {
    const action = getCaliTableAction(getCaliTableDesignPoint(event));
    if (!runCaliTableAction(action)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  frameDocument.addEventListener('pointerup', handleTableInput, true);
  frameDocument.addEventListener('click', handleTableInput, true);
}

function renderHall(status) {
  if (hallAccount) {
    hallAccount.textContent = getStoredAccount();
  }
  if (hallBalance) {
    hallBalance.textContent = formatMoney(status?.balance ?? state.baccarat.balance);
  }
  if (hallRange) {
    hallRange.textContent = '5 - 3,000';
  }
  patchCaliHallFrame(status);
}

function renderBaccarat(status) {
  state.baccarat.balance = status.balance;
  state.baccarat.roundId = status.round.id;
  state.baccarat.totals = status.totals;

  baccaratBalance.textContent = formatMoney(status.balance);
  baccaratRound.textContent = status.round.id;
  document.getElementById('playerTotal').textContent = formatMoney(status.totals.player);
  document.getElementById('bankerTotal').textContent = formatMoney(status.totals.banker);
  document.getElementById('tieTotal').textContent = formatMoney(status.totals.tie);
  renderHall(status);
  patchCaliTableFrame(status);
  renderLocalLedger();
}

async function loadBaccaratStatus() {
  let status;
  try {
    status = await request('/api/v1/baccarat/status');
  } catch (error) {
    if (!isApiUnavailable(error)) {
      throw error;
    }
    status = readLocalBaccaratState();
  }
  renderBaccarat(status);
}

function placeLocalBaccaratBet(side, amount) {
  const localState = readLocalBaccaratState();
  if (!['player', 'banker', 'tie'].includes(side)) {
    throw new Error('下注區錯誤');
  }
  if (localState.balance < amount) {
    throw new Error('餘額不足');
  }

  localState.balance = Number((localState.balance - amount).toFixed(2));
  localState.totals[side] = Number((Number(localState.totals[side] || 0) + amount).toFixed(2));
  return writeLocalBaccaratState(localState);
}

async function loadHallStatus() {
  try {
    await loadBaccaratStatus();
  } catch (_error) {
    renderHall();
  }
}

async function placeBaccaratBet(side) {
  baccaratMessage.textContent = '下注中';
  try {
    let result;
    try {
      result = await request('/api/v1/baccarat/bet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side, amount: state.selectedChip }),
      });
    } catch (error) {
      if (!isApiUnavailable(error)) {
        throw error;
      }
      result = placeLocalBaccaratBet(side, state.selectedChip);
    }
    renderBaccarat(result);
    baccaratMessage.textContent = `已下注 ${formatMoney(state.selectedChip)}`;
    showTableStatus(`已下注 ${formatMoney(state.selectedChip)}`);
  } catch (error) {
    baccaratMessage.textContent = error.message;
    showTableStatus(error.message);
  }
}

async function settleBaccarat(outcome) {
  baccaratMessage.textContent = '結算中';
  try {
    let result;
    try {
      result = await request('/api/v1/baccarat/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
    } catch (error) {
      if (!isApiUnavailable(error)) {
        throw error;
      }
      const localState = readLocalBaccaratState();
      localState.totals = { player: 0, banker: 0, tie: 0 };
      localState.round = { id: `LOCAL-${Date.now()}` };
      result = writeLocalBaccaratState(localState);
    }
    renderBaccarat({ balance: result.balance, round: result.round, totals: result.totals });
    baccaratMessage.textContent = `本局結果：${{ player: '閒', banker: '莊', tie: '和' }[outcome]}`;
    setTimeout(() => loadBaccaratStatus().catch(() => undefined), 650);
  } catch (error) {
    baccaratMessage.textContent = error.message;
  }
}

async function applyDetectedBaccaratOutcome(detection) {
  if (!detection?.outcome || !detection?.detectionKey) {
    return;
  }

  if (detection.confidence < 0.6 || appliedOutcomeDetectionKeys.has(detection.detectionKey)) {
    return;
  }

  appliedOutcomeDetectionKeys.add(detection.detectionKey);
  baccaratMessage.textContent = '辨識結果結算中';
  try {
    const result = await request('/api/v1/baccarat/detected-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        outcome: detection.outcome,
        detectionKey: detection.detectionKey,
        source: detection.source,
        confidence: detection.confidence,
        externalRoundId: detection.externalRoundId,
      }),
    });
    renderBaccarat(result);
    const label = { player: '閒', banker: '莊', tie: '和' }[detection.outcome] || detection.outcome;
    baccaratMessage.textContent = result.applied ? `自動結算：${label}` : `已略過重複結果：${label}`;
    setTimeout(() => loadBaccaratStatus().catch(() => undefined), 650);
  } catch (error) {
    appliedOutcomeDetectionKeys.delete(detection.detectionKey);
    baccaratMessage.textContent = error.message;
  }
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
  clearFramePlaybackQueue();
}

function stopOutcomePolling() {
  if (state.outcomePollTimer) {
    clearInterval(state.outcomePollTimer);
    state.outcomePollTimer = null;
  }
  state.outcomePollErrors = 0;
  state.lastOutcomeLogId = 0;
}

async function pollDetectedBaccaratOutcome() {
  if (!state.bridgeSessionId) {
    return;
  }

  const query = new URLSearchParams({
    afterId: String(state.lastOutcomeLogId),
    limit: '300',
  });

  try {
    const result = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/baccarat-outcome?${query}`);
    state.outcomePollErrors = 0;
    if (typeof result.lastLogId === 'number') {
      state.lastOutcomeLogId = Math.max(state.lastOutcomeLogId, result.lastLogId);
    }
    if (result.detection) {
      await applyDetectedBaccaratOutcome(result.detection);
    }
  } catch (_error) {
    state.outcomePollErrors += 1;
    if (state.outcomePollErrors >= 5) {
      stopOutcomePolling();
    }
  }
}

function startOutcomePolling() {
  stopOutcomePolling();
  pollDetectedBaccaratOutcome().catch(() => undefined);
  state.outcomePollTimer = setInterval(() => {
    pollDetectedBaccaratOutcome().catch(() => undefined);
  }, 1200);
}

function clearFramePlaybackQueue() {
  if (state.framePlaybackTimer) {
    clearTimeout(state.framePlaybackTimer);
    state.framePlaybackTimer = null;
  }
  state.framePlaybackQueue = [];
}

function displayBridgeFrame(frameSrc) {
  frameScreenEl.src = frameSrc;
  frameScreenEl.hidden = false;
  screenEl.hidden = true;
  state.frameSeen = true;
  hideLoading();
  setSessionState('已連線 · 3秒延遲');
}

function renderDelayedBridgeFrames() {
  const readyAt = Date.now() - FRAME_PLAYBACK_DELAY_MS;
  let frameToDisplay = null;

  while (state.framePlaybackQueue.length && state.framePlaybackQueue[0].receivedAt <= readyAt) {
    frameToDisplay = state.framePlaybackQueue.shift();
  }

  if (frameToDisplay) {
    displayBridgeFrame(frameToDisplay.src);
  }
}

function scheduleDelayedBridgePlayback() {
  if (state.framePlaybackTimer || !state.framePlaybackQueue.length) {
    return;
  }

  const nextFrame = state.framePlaybackQueue[0];
  const delayMs = Math.max(0, nextFrame.receivedAt + FRAME_PLAYBACK_DELAY_MS - Date.now());
  state.framePlaybackTimer = setTimeout(() => {
    state.framePlaybackTimer = null;
    renderDelayedBridgeFrames();
    scheduleDelayedBridgePlayback();
  }, delayMs);
}

function queueBridgeFrame(frame) {
  state.framePlaybackQueue.push({
    src: `data:${frame.mimeType || 'image/jpeg'};base64,${frame.imageBase64}`,
    receivedAt: Date.now(),
  });

  if (state.framePlaybackQueue.length > 90) {
    state.framePlaybackQueue.splice(0, state.framePlaybackQueue.length - 90);
  }

  renderDelayedBridgeFrames();
  scheduleDelayedBridgePlayback();
}

async function fetchFrame() {
  if (!state.bridgeSessionId || state.frameFetchInProgress) {
    return;
  }

  state.frameFetchInProgress = true;
  try {
    const frame = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/frame`);
    queueBridgeFrame(frame);
    state.framePollErrors = 0;
    if (!state.frameSeen) {
      setSessionState('已連線 · 建立3秒緩衝');
    }
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
  frameScreenEl.hidden = true;
  state.frameSeen = false;
  showLoading('建立 3 秒緩衝', '正在接入本機 Cali 畫面');
  setSessionState('已連線 · 建立3秒緩衝');
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
  if (!bridgeSessionId || state.closingSession) {
    return;
  }

  state.closingSession = true;
  clearIdleShutdown();
  clearConnectWatchdog();
  stopOutcomePolling();
  stopFramePolling();
  if (state.room) {
    state.room.disconnect();
    state.room = null;
  }

  state.bridgeSessionId = '';
  screenEl.srcObject = null;
  const closeRequest = fetch(`${getApiBase()}/api/v1/bridge/sessions/${bridgeSessionId}`, {
    method: 'DELETE',
    keepalive: Boolean(options.keepalive),
  }).catch(() => undefined);

  if (!options.keepalive) {
    await closeRequest;
  }

  if (options.reason === 'idle') {
    screenEl.hidden = false;
    frameScreenEl.hidden = true;
    showLoading('閒置已關閉', '點擊重連重新進入遊戲');
    setSessionState('已停止');
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

async function startBridgeSession() {
  showLoading('建立橋接', '正在接入你開著的 Cali 遊戲畫面');
  setSessionState('建立橋接中');
  const startResult = await request('/api/v1/bridge/sessions/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'calibet', streamMode: getPreferredBridgeStreamMode() }),
  });

  state.bridgeSessionId = startResult.bridgeSessionId;
  scheduleIdleShutdown();
  startOutcomePolling();

  if (startResult.streamMode === 'livekit') {
    const liveKit = await request(`/api/v1/bridge/sessions/${state.bridgeSessionId}/livekit-token`);
    await connectLiveKit(liveKit.url, liveKit.token);
    return;
  }

  startFramePolling();
}

async function enterGame() {
  setView('table');
  const hasCaliLiveFrame = applyCaliLiveFrame();
  try {
    await loadBaccaratStatus();
  } catch (_error) {
    renderHall();
  }
  applyCaliTableScale();
  attachCaliTableControls();
  if (hasCaliLiveFrame) {
    hideLoading();
    setSessionState('Cali 畫面已接入');
    return;
  }

  try {
    await startBridgeSession();
  } catch (error) {
    showLoading('橋接未連線', error.message);
    setSessionState('橋接未連線');
  }
}

function enterSelectedTable(tableId) {
  state.selectedTable = tableId;
  enterGame().catch((error) => {
    showLoading('連線失敗', error.message);
    setSessionState('連線失敗');
  });
}

async function returnToHall() {
  await closeBridgeSession();
  if (state.inputAckTimer) {
    clearTimeout(state.inputAckTimer);
    state.inputAckTimer = null;
  }
  screenEl.srcObject = null;
  screenEl.hidden = false;
  frameScreenEl.hidden = true;
  if (caliLiveFrame) {
    caliLiveFrame.hidden = true;
    caliLiveFrame.removeAttribute('src');
  }
  appShell.dataset.live = 'missing';
  state.selectedTable = null;
  setView('hall');
  loadHallStatus().catch(() => undefined);
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
  state.recordsOpen = true;
  const modal = document.getElementById('recordsModal');
  const frame = document.getElementById('recordsFrame');

  if (state.bridgeSessionId) {
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
  if (state.recordsFromHall && !state.bridgeSessionId) {
    state.recordsFromHall = false;
    setView('hall');
  }
}

function isRecordAreaClick(xRatio, yRatio) {
  return xRatio >= 0.76 && yRatio <= 0.15;
}

function getActiveScreenElement() {
  return frameScreenEl && !frameScreenEl.hidden ? frameScreenEl : screenEl;
}

function isLocalOverlayEvent(event) {
  return hallPanel?.contains(event.target)
    || baccaratPanel?.contains(event.target)
    || event.target === document.getElementById('recordsHotspot');
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
  if (isLocalOverlayEvent(event)) {
    return;
  }

  state.lastPointerActionAt = Date.now();
  handleStageClick(event.clientX, event.clientY);
}

screenFrame?.addEventListener('click', (event) => {
  if (isLocalOverlayEvent(event)) {
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

baccaratPanel?.addEventListener('click', (event) => {
  event.stopPropagation();
});

baccaratPanel?.addEventListener('pointerup', (event) => {
  event.stopPropagation();
});

document.querySelectorAll('[data-chip]').forEach((button) => {
  button.addEventListener('click', () => {
    setSelectedChip(button.dataset.chip);
  });
});

document.querySelectorAll('[data-bet-side]').forEach((button) => {
  button.addEventListener('click', () => {
    placeBaccaratBet(button.dataset.betSide).catch(() => undefined);
  });
});

document.querySelectorAll('[data-settle]').forEach((button) => {
  button.addEventListener('click', () => {
    settleBaccarat(button.dataset.settle).catch(() => undefined);
  });
});

document.getElementById('resetBaccaratBtn').addEventListener('click', async () => {
  const result = await request('/api/v1/baccarat/reset', { method: 'POST' });
  renderBaccarat({ balance: result.balance, round: result.round, totals: { player: 0, banker: 0, tie: 0 } });
  baccaratMessage.textContent = '已重置';
});

document.getElementById('recordsBtn').addEventListener('click', () => {
  openRecordsModal().catch(() => undefined);
});
document.getElementById('hallRecordsBtn').addEventListener('click', () => {
  state.recordsFromHall = true;
  setView('table');
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
document.getElementById('hallFullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => undefined);
    return;
  }
  document.exitFullscreen().catch(() => undefined);
});
document.querySelectorAll('[data-open-table]').forEach((tableCard) => {
  const open = () => enterSelectedTable(tableCard.dataset.openTable);
  tableCard.addEventListener('click', open);
  tableCard.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
});
caliHallFrame?.addEventListener('load', () => {
  patchCaliHallFrame();
  attachCaliHallControls();
});
caliTableFrame?.addEventListener('load', () => {
  applyCaliTableScale();
  attachCaliTableControls();
});
function handleTableLayerInput(event) {
  const action = getCaliTableAction(getCaliTableDesignPoint(event));
  if (runCaliTableAction(action)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

tableSystemLayer?.addEventListener('pointerup', handleTableLayerInput, true);
tableSystemLayer?.addEventListener('click', handleTableLayerInput, true);
window.addEventListener('resize', () => {
  applyCaliHallScale();
  applyCaliTableScale();
});
document.getElementById('tableBackHotspot')?.addEventListener('click', () => {
  returnToHall().catch(() => undefined);
});
document.getElementById('tableRecordsHotspot')?.addEventListener('click', () => {
  openRecordsModal().catch(() => undefined);
});
document.getElementById('tableFullscreenHotspot')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => undefined);
    return;
  }
  document.exitFullscreen().catch(() => undefined);
});
document.getElementById('backHallBtn').addEventListener('click', () => {
  returnToHall().catch(() => undefined);
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await closeBridgeSession();
  if (state.inputAckTimer) {
    clearTimeout(state.inputAckTimer);
    state.inputAckTimer = null;
  }
  screenEl.srcObject = null;
  screenEl.hidden = false;
  frameScreenEl.hidden = true;
  enterGame().catch((error) => {
    showLoading('連線失敗', error.message);
    setSessionState('連線失敗');
  });
});

window.addEventListener('pagehide', () => {
  closeBridgeSession({ keepalive: true }).catch(() => undefined);
});

loadHallStatus().catch((error) => {
  baccaratMessage.textContent = error.message;
});
