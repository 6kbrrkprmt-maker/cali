const recordParams = new URLSearchParams(window.location.search);

if (window.self !== window.top || recordParams.get('embedded') === '1') {
  document.body.classList.add('embedded');
}

const state = {
  token: localStorage.getItem('platformToken') || '',
  tab: 'bet',
  page: 1,
  totalPages: 1,
};

const schemas = {
  bet: {
    endpoint: '/api/v1/records/bet',
    typeOptions: ['全部', '龍虎'],
    headers: ['交易單號', '遊戲', '桌號', '局號', '下注時間', '下注內容', '投注額', '有效投注', '輸贏', '狀態'],
    keys: ['orderNo', 'gameType', 'tableNo', 'roundNo', 'betTime', 'betType', 'betAmount', 'validAmount', 'winLoss', 'status'],
    totals: [['小計:', 'betAmount', 'validAmount', 'winLoss'], ['總計:', 'betAmount', 'validAmount', 'winLoss']],
  },
  credit: {
    endpoint: '/api/v1/records/credit',
    typeOptions: ['全部', '轉入', '轉出'],
    headers: ['交易單號', '操作時間', '交易類型', '交易前餘額', '收入', '支出', '交易後餘額'],
    keys: ['transactionNo', 'operationTime', 'transactionType', 'balanceBefore', 'income', 'expense', 'balanceAfter'],
    totals: [['小計:', 'income', 'expense'], ['總計:', 'income', 'expense']],
  },
  egame: {
    endpoint: '/api/v1/records/egame',
    typeOptions: ['全部', '電子遊戲'],
    headers: ['交易單號', '平台', '遊戲代碼', '下注時間', '遊戲類型', '投注額', '輸贏', '有效投注'],
    keys: ['orderNo', 'platformCode', 'gameCode', 'betTime', 'gameType', 'betAmount', 'winLoss', 'validAmount'],
    totals: [['小計:', 'betAmount', 'winLoss', 'validAmount'], ['總計:', 'betAmount', 'winLoss', 'validAmount']],
  },
};

function getApiBase() {
  return document.getElementById('apiBase').value.trim().replace(/\/$/, '');
}

function setLoginStatus(text) {
  document.getElementById('loginStatus').textContent = text;
}

async function request(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${getApiBase()}${path}`, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

async function login() {
  const account = document.getElementById('account').value.trim();
  const password = document.getElementById('password').value;

  setLoginStatus('登入中...');
  const data = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });

  state.token = data.accessToken;
  localStorage.setItem('platformToken', state.token);
  setLoginStatus(`${data.user.account} / ${data.user.role}`);
  await loadRecords();
}

function renderTable(data) {
  const schema = schemas[state.tab];
  const tableHead = document.getElementById('tableHead');
  const tableBody = document.getElementById('tableBody');
  const empty = document.getElementById('empty');

  tableHead.innerHTML = `<tr>${schema.headers.map((header) => `<th>${header}</th>`).join('')}</tr>`;
  tableBody.innerHTML = '';

  empty.hidden = data.rows.length !== 0;
  for (const row of data.rows) {
    const cells = schema.keys.map((key) => `<td>${row[key] ?? ''}</td>`).join('');
    tableBody.insertAdjacentHTML('beforeend', `<tr>${cells}</tr>`);
  }

  document.getElementById('totalItems').textContent = `總計: ${data.totalItems}`;
  document.getElementById('pageNo').textContent = `${data.page}/${data.totalPages}`;
  state.page = data.page;
  state.totalPages = data.totalPages;
  document.getElementById('nextPage').disabled = state.page >= state.totalPages;
  document.getElementById('lastPage').disabled = state.page >= state.totalPages;

  const totals = schema.totals.map(([label, ...keys]) => {
    const source = label === '小計:' ? data.subtotal : data.total;
    return `<div class="total-row"><span>${label}</span>${keys.map((key) => `<span>${source[key] ?? '0.00'}</span>`).join('')}</div>`;
  });
  document.getElementById('totals').innerHTML = totals.join('');
}

async function loadRecords() {
  if (!state.token) {
    setLoginStatus('請先登入');
    return;
  }

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: '10',
  });
  const keyword = document.getElementById('keyword').value.trim();
  const recordType = document.getElementById('recordType').value;
  const startAt = document.getElementById('startAt').value.trim();
  const endAt = document.getElementById('endAt').value.trim();

  if (keyword) params.set('keyword', keyword);
  if (recordType && recordType !== '全部') params.set('recordType', recordType);
  if (startAt) params.set('startAt', startAt);
  if (endAt) params.set('endAt', endAt);

  const data = await request(`${schemas[state.tab].endpoint}?${params.toString()}`);
  renderTable(data);
}

function renderTypeOptions() {
  const recordType = document.getElementById('recordType');
  recordType.innerHTML = schemas[state.tab].typeOptions.map((option) => `<option>${option}</option>`).join('');
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', async () => {
    document.querySelector('.tab.active').classList.remove('active');
    tab.classList.add('active');
    state.tab = tab.dataset.tab;
    state.page = 1;
    renderTypeOptions();
    await loadRecords();
  });
}

document.getElementById('loginBtn').addEventListener('click', () => {
  login().catch((error) => setLoginStatus(error.message));
});
document.getElementById('searchBtn').addEventListener('click', () => {
  state.page = 1;
  loadRecords().catch((error) => setLoginStatus(error.message));
});
document.getElementById('nextPage').addEventListener('click', () => {
  if (state.page < state.totalPages) {
    state.page += 1;
    loadRecords().catch((error) => setLoginStatus(error.message));
  }
});
document.getElementById('lastPage').addEventListener('click', () => {
  if (state.page < state.totalPages) {
    state.page = state.totalPages;
    loadRecords().catch((error) => setLoginStatus(error.message));
  }
});

renderTypeOptions();

if (state.token) {
  setLoginStatus('已載入 token');
  loadRecords().catch(() => setLoginStatus('token 失效，請重新登入'));
}
