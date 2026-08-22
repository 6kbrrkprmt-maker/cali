const state = {
  token: localStorage.getItem('platformToken') || '',
  endpoint: 'bet',
  recordKind: 'BET',
  selected: null,
};

function getApiBase() {
  return document.getElementById('apiBase').value.trim().replace(/\/$/, '');
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function setResult(text) {
  document.getElementById('result').textContent = text;
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

async function login() {
  const account = document.getElementById('account').value.trim();
  const password = document.getElementById('password').value;
  const data = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  state.token = data.accessToken;
  localStorage.setItem('platformToken', state.token);
  setStatus(`${data.user.account} / ${data.user.role}`);
  await loadRecords();
}

function getRecordLabel(record) {
  return record.orderNo || record.transactionNo || record.id;
}

function renderRecords(rows) {
  const list = document.getElementById('recordList');
  list.innerHTML = '';
  for (const record of rows) {
    const item = document.createElement('button');
    item.className = 'record-item';
    item.innerHTML = `<strong>${getRecordLabel(record)}</strong><small>${record.betTime || record.operationTime || ''}</small><small>${record.gameType || record.transactionType || ''}</small>`;
    item.addEventListener('click', () => selectRecord(record, item));
    list.appendChild(item);
  }
}

function selectRecord(record, item) {
  state.selected = record;
  for (const button of document.querySelectorAll('.record-item.active')) {
    button.classList.remove('active');
  }
  item.classList.add('active');
  document.getElementById('selectedLabel').textContent = getRecordLabel(record);
  document.getElementById('nextValue').value = JSON.stringify(suggestAdjustment(record), null, 2);
}

function suggestAdjustment(record) {
  if (state.recordKind === 'BET') {
    return {
      betAmount: record.betAmount,
      validAmount: record.validAmount,
      winLoss: record.winLoss,
      status: record.status,
    };
  }
  if (state.recordKind === 'CREDIT') {
    return {
      income: record.income,
      expense: record.expense,
      balanceAfter: record.balanceAfter,
    };
  }
  return {
    betAmount: record.betAmount,
    winLoss: record.winLoss,
    validAmount: record.validAmount,
  };
}

async function loadRecords() {
  if (!state.token) {
    setStatus('請先登入');
    return;
  }
  const data = await request(`/api/v1/records/${state.endpoint}?pageSize=100`);
  state.selected = null;
  document.getElementById('selectedLabel').textContent = '尚未選擇';
  renderRecords(data.rows);
  setResult(`已載入 ${data.rows.length} 筆`);
}

async function saveAdjustment() {
  if (!state.selected) {
    setResult('請先選擇一筆紀錄');
    return;
  }

  let nextValue;
  try {
    nextValue = JSON.parse(document.getElementById('nextValue').value);
  } catch (error) {
    setResult(`JSON 格式錯誤: ${error.message}`);
    return;
  }

  const result = await request('/api/v1/records/adjustments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recordKind: state.recordKind,
      recordId: state.selected.id,
      reason: document.getElementById('reason').value.trim(),
      changeNote: document.getElementById('changeNote').value.trim(),
      nextValue,
    }),
  });

  setResult(JSON.stringify(result, null, 2));
  await loadRecords();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', async () => {
    document.querySelector('.tab.active').classList.remove('active');
    tab.classList.add('active');
    state.recordKind = tab.dataset.kind;
    state.endpoint = tab.dataset.endpoint;
    await loadRecords();
  });
}

document.getElementById('loginBtn').addEventListener('click', () => {
  login().catch((error) => setResult(error.message));
});
document.getElementById('saveBtn').addEventListener('click', () => {
  saveAdjustment().catch((error) => setResult(error.message));
});

if (state.token) {
  setStatus('已載入 token');
  loadRecords().catch((error) => setResult(error.message));
}
