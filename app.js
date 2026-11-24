'use strict';
/* =========================================================
 * 家計簿アプリ（Olive / Gmail 連携対応）
 * データは localStorage に保存。JSON でバックアップ・復元可能。
 * ========================================================= */

const STORE_KEY = 'kakeibo.v1';
const TOKEN_KEY = 'kakeibo.gtoken';
const METHODS = ['現金', 'クレカ', 'その他'];
const DEFAULT_CATEGORIES = ['食費', '日用品', '交通費', '外食', '趣味・娯楽', '衣服・美容', '交際費',
  '医療', '住居', '水道光熱費', '通信費', 'サブスク', '教育', 'その他'];
const PALETTE = ['#2f7d5b', '#e07a3f', '#3f7fc4', '#c9a227', '#9b59b6', '#d4526e', '#17a2a2',
  '#7a8b2e', '#8c6d4f', '#5c6bc0', '#e57fb0', '#4caf50', '#ff9f40', '#7f8c8d'];
const METHOD_COLORS = { '現金': '#2f7d5b', 'クレカ': '#e07a3f', 'その他': '#3f7fc4' };
const PARSER_VERSION = 2;
const OLD_QUERIES = ['(Olive OR from:vpass.ne.jp OR from:smbc.co.jp) ご利用'];
const DEFAULT_QUERY = 'from:(statement@vpass.ne.jp OR smbc.co.jp) ご利用日時';

/* ---------- 状態 ---------- */
let state = load();
let cur = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; })();
const charts = {};

function defaultState() {
  return {
    version: 1,
    entries: [],   // {id,date,amount,category,method,memo,source:'manual'|'olive',gmailId?}
    incomes: [],   // {id,date,amount,source,memo}
    categories: DEFAULT_CATEGORIES.slice(),
    parserVersion: PARSER_VERSION,
    mailLog: {},        // gmailId -> {ym, status:'skipped'|'cancel'|'netted'|'deleted'}
    pendingCancels: [], // 対応する購入がまだ見つからない取消 {gmailId,ym,dt,shop,amount}
    settings: {
      clientId: '',
      query: DEFAULT_QUERY,
      oliveCategory: 'その他',
      autoSync: false,
    },
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (e) { return defaultState(); }
}
function migrate(s) {
  const d = defaultState();
  const st = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
  if ((s.parserVersion || 1) < PARSER_VERSION) {
    // 旧バージョンで「読み取れない」と判定されたメールを再解析できるようにリセット
    delete st.ignoredGmailIds;
    st.mailLog = {}; st.pendingCancels = [];
    if (OLD_QUERIES.includes(st.settings.query)) st.settings.query = DEFAULT_QUERY;
    st.parserVersion = PARSER_VERSION;
  }
  st.mailLog ||= {}; st.pendingCancels ||= [];
  return st;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('保存に失敗しました（容量不足の可能性）'); }
}

/* ---------- ユーティリティ ---------- */
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const yen = (n) => Math.round(n).toLocaleString('ja-JP') + '円';
const pad = (n) => String(n).padStart(2, '0');
const ymKey = (y, m) => `${y}-${pad(m)}`;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const inMonth = (dateStr, y, m) => dateStr.startsWith(ymKey(y, m));
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['日', '月', '火', '水', '木', '金', '土'];

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function defaultDateForMonth() {
  const t = todayStr();
  return inMonth(t, cur.y, cur.m) ? t : `${ymKey(cur.y, cur.m)}-01`;
}
function segValue(el) { return el.querySelector('.on')?.dataset.v; }
function segSet(el, v) { el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function bindSeg(el) {
  el.addEventListener('click', e => { const b = e.target.closest('button'); if (b) segSet(el, b.dataset.v); });
}
function catColor(cat) {
  const i = state.categories.indexOf(cat);
  return PALETTE[(i < 0 ? state.categories.length : i) % PALETTE.length];
}

/* ---------- 描画 ---------- */
function monthData(y = cur.y, m = cur.m) {
  const entries = state.entries.filter(e => inMonth(e.date, y, m));
  const incomes = state.incomes.filter(e => inMonth(e.date, y, m));
  const expense = entries.reduce((a, e) => a + e.amount, 0);
  const income = incomes.reduce((a, e) => a + e.amount, 0);
  return { entries, incomes, expense, income };
}

function renderAll() {
  $('monthLabel').textContent = `${cur.y}年${cur.m}月`;
  const d = monthData();
  $('sumIncome').textContent = yen(d.income);
  $('sumExpense').textContent = yen(d.expense);
  $('sumBalance').textContent = (d.income - d.expense < 0 ? '−' : '') + yen(Math.abs(d.income - d.expense));
  renderSelects();
  renderLists(d);
  if (!$('tab-chart').hidden) renderCharts(d);
}

function renderSelects() {
  const opts = state.categories.map(c => `<option>${esc(c)}</option>`).join('');
  for (const id of ['exCategory', 'edCategory', 'oliveCategory']) {
    const el = $(id); const v = el.value; el.innerHTML = opts;
    if (state.categories.includes(v)) el.value = v;
  }
  $('oliveCategory').value = state.categories.includes(state.settings.oliveCategory)
    ? state.settings.oliveCategory : state.categories[state.categories.length - 1];
}

function renderLists(d) {
  // 支出: 日別グループ
  const box = $('expenseList');
  if (!d.entries.length) { box.innerHTML = '<div class="empty">この月の支出はまだありません</div>'; }
  else {
    const byDay = {};
    d.entries.forEach(e => (byDay[e.date] ||= []).push(e));
    box.innerHTML = Object.keys(byDay).sort().reverse().map(day => {
      const list = byDay[day];
      const total = list.reduce((a, e) => a + e.amount, 0);
      const dt = new Date(day + 'T00:00:00');
      return `<div class="day-h"><span>${dt.getMonth() + 1}/${dt.getDate()}（${WD[dt.getDay()]}）</span><span>${yen(total)}</span></div>
        <ul class="list">${list.map(e => `
          <li data-id="${e.id}" data-kind="entry">
            <span class="dot" style="background:${catColor(e.category)}"></span>
            <div class="main">
              <div class="t">${esc(e.memo || e.category)}</div>
              <div class="m">${e.source === 'olive' ? '<span class="tag olive">Olive</span>' : ''}<span class="tag">${esc(e.method)}</span>${esc(e.category)}</div>
            </div>
            <span class="amt">${yen(e.amount)}</span>
            <button aria-label="編集">✎</button>
          </li>`).join('')}</ul>`;
    }).join('');
  }
  // 収入
  const il = $('incomeList');
  il.innerHTML = d.incomes.length ? d.incomes.sort((a, b) => b.date.localeCompare(a.date)).map(e => `
    <li data-id="${e.id}" data-kind="income">
      <div class="main"><div class="t">${esc(e.source)}${e.memo ? '・' + esc(e.memo) : ''}</div>
      <div class="m">${e.date.slice(5).replace('-', '/')}</div></div>
      <span class="amt inc">+${yen(e.amount)}</span>
      <button aria-label="削除">🗑</button>
    </li>`).join('') : '<div class="empty">この月の収入はまだありません</div>';
}

function chartTheme() {
  const cs = getComputedStyle(document.documentElement);
  return { text: cs.getPropertyValue('--sub').trim(), grid: cs.getPropertyValue('--line').trim() };
}
function makeChart(key, canvasId, config) {
  if (typeof Chart === 'undefined') return;
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart($(canvasId), config);
}

function renderCharts(d = monthData()) {
  const th = chartTheme();
  if (typeof Chart !== 'undefined') { Chart.defaults.color = th.text; Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; }

  // 円グラフ: 用途別
  const byCat = {};
  d.entries.forEach(e => byCat[e.category] = (byCat[e.category] || 0) + e.amount);
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  makeChart('pie', 'pieChart', {
    type: 'doughnut',
    data: { labels: cats, datasets: [{ data: cats.map(c => byCat[c]), backgroundColor: cats.map(catColor), borderWidth: 2, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--card').trim() }] },
    options: { maintainAspectRatio: false, cutout: '55%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.label}: ${yen(c.raw)}（${(c.raw / d.expense * 100).toFixed(1)}%）` } } } },
  });
  $('pieTable').innerHTML = cats.length ? cats.map(c =>
    `<tr><td><span class="dot" style="background:${catColor(c)}"></span>${esc(c)}</td><td>${yen(byCat[c])}（${(byCat[c] / d.expense * 100).toFixed(1)}%）</td></tr>`).join('')
    : '<tr><td class="empty">データがありません</td></tr>';

  // 棒グラフ: 日別×決済方法
  const n = daysIn(cur.y, cur.m);
  const labels = Array.from({ length: n }, (_, i) => `${i + 1}`);
  const datasets = METHODS.map(mt => {
    const arr = new Array(n).fill(0);
    d.entries.filter(e => e.method === mt).forEach(e => arr[+e.date.slice(8, 10) - 1] += e.amount);
    return { label: mt, data: arr, backgroundColor: METHOD_COLORS[mt], borderRadius: 3, stack: 's' };
  });
  makeChart('daily', 'dailyChart', {
    type: 'bar', data: { labels, datasets },
    options: { maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
        y: { stacked: true, grid: { color: th.grid }, ticks: { callback: v => v.toLocaleString() } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: { callbacks: { title: c => `${cur.m}/${c[0].label}`, label: c => `${c.dataset.label}: ${yen(c.raw)}` } } } },
  });

  // 棒グラフ: 直近6か月
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(cur.y, cur.m - 1 - i, 1);
    months.push({ y: dt.getFullYear(), m: dt.getMonth() + 1 });
  }
  const md = months.map(x => monthData(x.y, x.m));
  makeChart('monthly', 'monthlyChart', {
    type: 'bar',
    data: { labels: months.map(x => `${x.m}月`), datasets: [
      { label: '収入', data: md.map(x => x.income), backgroundColor: '#3f7fc4', borderRadius: 4 },
      { label: '支出', data: md.map(x => x.expense), backgroundColor: '#e07a3f', borderRadius: 4 }] },
    options: { maintainAspectRatio: false,
      scales: { x: { grid: { display: false } }, y: { grid: { color: th.grid }, ticks: { callback: v => v.toLocaleString() } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${yen(c.raw)}` } } } },
  });

  // 決済方法別合計
  $('methodTable').innerHTML = METHODS.map(mt => {
    const v = d.entries.filter(e => e.method === mt).reduce((a, e) => a + e.amount, 0);
    return `<tr><td><span class="dot" style="background:${METHOD_COLORS[mt]}"></span>${mt}</td><td>${yen(v)}</td></tr>`;
  }).join('') + (() => {
    const ol = d.entries.filter(e => e.source === 'olive').reduce((a, e) => a + e.amount, 0);
    return `<tr><td>うち Olive 取り込み分</td><td>${yen(ol)}</td></tr>`;
  })();
}

/* ---------- 入力 ---------- */
function setupForms() {
  bindSeg($('exMethod')); bindSeg($('edMethod'));
  $('exDate').value = defaultDateForMonth(); $('inDate').value = defaultDateForMonth();

  $('expenseForm').addEventListener('submit', e => {
    e.preventDefault();
    const amount = Math.round(+$('exAmount').value);
    if (!(amount > 0)) return toast('金額を入力してください');
    state.entries.push({ id: uid(), date: $('exDate').value, amount, category: $('exCategory').value,
      method: segValue($('exMethod')), memo: $('exMemo').value.trim(), source: 'manual' });
    save(); $('exAmount').value = ''; $('exMemo').value = '';
    jumpTo($('exDate').value); toast('支出を追加しました');
  });

  $('incomeForm').addEventListener('submit', e => {
    e.preventDefault();
    const amount = Math.round(+$('inAmount').value);
    if (!(amount > 0)) return toast('金額を入力してください');
    state.incomes.push({ id: uid(), date: $('inDate').value, amount, source: $('inSource').value, memo: $('inMemo').value.trim() });
    save(); $('inAmount').value = ''; $('inMemo').value = '';
    jumpTo($('inDate').value); toast('収入を追加しました');
  });

  // 一覧の操作
  document.querySelector('#tab-list').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    if (li.dataset.kind === 'income') {
      if (e.target.closest('button') && confirm('この収入を削除しますか？')) {
        state.incomes = state.incomes.filter(x => x.id !== li.dataset.id); save(); renderAll();
      }
    } else openEdit(li.dataset.id);
  });

  const dlg = $('editDlg');
  $('editForm').addEventListener('submit', e => {
    const action = e.submitter?.value; const id = dlg.dataset.id;
    if (action === 'save') {
      const en = state.entries.find(x => x.id === id); if (!en) return;
      Object.assign(en, { date: $('edDate').value, amount: Math.round(+$('edAmount').value), category: $('edCategory').value,
        method: segValue($('edMethod')), memo: $('edMemo').value.trim() });
      save(); renderAll(); toast('保存しました');
    } else if (action === 'delete') {
      const en = state.entries.find(x => x.id === id);
      // Olive 取り込み分は削除しても再同期で復活しないよう記録
      if (en?.gmailId) state.mailLog[en.gmailId] = { ym: en.date.slice(0, 7), status: 'deleted' };
      state.entries = state.entries.filter(x => x.id !== id); save(); renderAll(); toast('削除しました');
    }
  });
}
function openEdit(id) {
  const en = state.entries.find(x => x.id === id); if (!en) return;
  const dlg = $('editDlg'); dlg.dataset.id = id;
  $('edDate').value = en.date; $('edAmount').value = en.amount; $('edCategory').value = en.category;
  segSet($('edMethod'), en.method); $('edMemo').value = en.memo || '';
  dlg.showModal();
}
function jumpTo(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  if (y !== cur.y || m !== cur.m) { cur = { y, m }; }
  renderAll();
}

/* ---------- タブ・月切替 ---------- */
function setupNav() {
  document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== 'tab-' + b.dataset.tab);
    if (b.dataset.tab === 'chart') renderCharts();
    window.scrollTo(0, 0);
  }));
  const shift = (k) => {
    const dt = new Date(cur.y, cur.m - 1 + k, 1); cur = { y: dt.getFullYear(), m: dt.getMonth() + 1 };
    $('exDate').value = defaultDateForMonth(); $('inDate').value = defaultDateForMonth(); $('syncStatus').textContent = '';
    renderAll();
  };
  $('prevM').onclick = () => shift(-1); $('nextM').onclick = () => shift(1);
}

/* ---------- 設定・保存 ---------- */
function setupSettings() {
  $('clientId').value = state.settings.clientId;
  $('gmailQuery').value = state.settings.query;
  $('autoSync').checked = state.settings.autoSync;
  $('catText').value = state.categories.join('\n');

  $('saveSettings').onclick = () => {
    state.settings.clientId = $('clientId').value.trim();
    state.settings.query = $('gmailQuery').value.trim() || defaultState().settings.query;
    state.settings.oliveCategory = $('oliveCategory').value;
    state.settings.autoSync = $('autoSync').checked;
    tokenClient = null; save(); toast('設定を保存しました');
  };
  $('signOut').onclick = () => {
    const t = getToken();
    if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
    sessionStorage.removeItem(TOKEN_KEY); toast('Google 連携を解除しました');
  };
  $('saveCats').onclick = () => {
    const list = [...new Set($('catText').value.split('\n').map(s => s.trim()).filter(Boolean))];
    if (!list.length) return toast('用途を1つ以上入力してください');
    state.categories = list; save(); renderAll(); toast('用途を保存しました');
  };

  $('exportJson').onclick = () => download(`kakeibo-backup-${todayStr()}.json`,
    JSON.stringify({ ...state, settings: { ...state.settings } }, null, 2), 'application/json');
  $('exportCsv').onclick = () => {
    const d = monthData();
    const rows = [['種別', '日付', '金額', '用途/項目', '決済方法', 'メモ', '取込元']];
    d.entries.sort((a, b) => a.date.localeCompare(b.date)).forEach(e => rows.push(['支出', e.date, e.amount, e.category, e.method, e.memo || '', e.source === 'olive' ? 'Olive' : '手入力']));
    d.incomes.forEach(e => rows.push(['収入', e.date, e.amount, e.source, '', e.memo || '', '手入力']));
    const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`kakeibo-${ymKey(cur.y, cur.m)}.csv`, csv, 'text/csv');
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!Array.isArray(s.entries) || !Array.isArray(s.incomes)) throw new Error('形式が違います');
      if (!confirm('現在のデータをバックアップの内容で置き換えますか？')) return;
      state = migrate(s);
      save(); setupSettings(); renderAll(); toast('復元しました');
    } catch (err) { toast('復元に失敗しました: ' + err.message); }
    e.target.value = '';
  };
  $('clearAll').onclick = () => {
    if (!confirm('すべてのデータを削除します。よろしいですか？（元に戻せません）')) return;
    const keep = state.settings; state = defaultState(); state.settings = keep; save(); setupSettings(); renderAll(); toast('削除しました');
  };
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* =========================================================
 * Gmail 連携（Olive 決済メールの取り込み）
 * ========================================================= */
let tokenClient = null;

function getToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.exp > Date.now() + 60000 ? t.token : null;
  } catch (e) { return null; }
}
function requestToken(interactive) {
  return new Promise((resolve, reject) => {
    if (!state.settings.clientId) return reject(new Error('設定タブで Google OAuth クライアントIDを入力してください'));
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google ログイン部品を読み込めませんでした（通信環境を確認してください）'));
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.settings.clientId,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + r.expires_in * 1000 }));
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.message || e.type || 'ログインがキャンセルされました')),
    });
    tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}
async function gmail(path, token) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) { sessionStorage.removeItem(TOKEN_KEY); throw new Error('認証の有効期限が切れました。もう一度同期してください'); }
  if (!r.ok) throw new Error(`Gmail API エラー (${r.status})`);
  return r.json();
}

// base64url → 文字列（charset 対応：ISO-2022-JP / Shift_JIS / UTF-8）
function decodePart(data, charset) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  try { return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(bytes); }
  catch (e) { return new TextDecoder('utf-8').decode(bytes); }
}
function extractText(payload) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    const ct = (p.headers || []).find(h => h.name.toLowerCase() === 'content-type')?.value || p.mimeType || '';
    const cs = /charset="?([\w-]+)"?/i.exec(ct)?.[1];
    if (p.body?.data) {
      if (p.mimeType === 'text/plain') plain += decodePart(p.body.data, cs) + '\n';
      else if (p.mimeType === 'text/html') html += decodePart(p.body.data, cs) + '\n';
    }
    (p.parts || []).forEach(walk);
  })(payload);
  if (plain.trim()) return plain;
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|td|li|h\d)>/gi, '\n'), 'text/html');
  return doc.body?.textContent || '';
}

/* ---------- Olive メール解析 ---------- */
// 全角英数記号→半角、各種マイナス記号を統一
function normalize(s) {
  return s.replace(/\r/g, '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[−‒–—－]/g, '-')
    .replace(/　| /g, ' ')
    .replace(/￥/g, '¥');
}

// 店名から使用用途を推測（該当なしなら設定の既定用途）
const CATEGORY_RULES = [
  ['外食', ['マクドナルド', 'すき家', '吉野家', '松屋', 'なか卯', 'スターバックス', 'STARBUCKS', 'ドトール', 'タリーズ', 'コメダ',
    'ガスト', 'サイゼリヤ', 'ケンタッキー', 'モスバーガー', 'バーガーキング', 'ロッテリア', 'ミスタードーナツ', 'くら寿司', 'スシロー',
    'はま寿司', '丸亀製麺', 'ココイチ', 'COCO壱', '日高屋', '王将', 'デニーズ', 'ジョナサン', 'UBER EATS', '出前館', 'WOLT']],
  ['食費', ['セブン-イレブン', 'セブンイレブン', 'ファミリーマート', 'ローソン', 'ミニストップ', 'デイリーヤマザキ', 'イオン', '西友',
    'ライフ', 'イトーヨーカドー', 'マルエツ', 'まいばすけっと', '業務スーパー', 'OKストア', '成城石井', 'サミット', 'ヤオコー', 'コープ']],
  ['交通費', ['JR', 'SUICA', 'スイカ', 'PASMO', 'ICOCA', 'タクシー', 'メトロ', '鉄道', 'ENEOS', '出光', 'コスモ石油', 'タイムズ']],
  ['日用品', ['マツモトキヨシ', 'マツキヨ', 'ウエルシア', 'スギ薬局', 'ツルハ', 'サンドラッグ', 'ココカラファイン', 'ダイソー', 'セリア',
    'キャンドゥ', 'ニトリ', '無印良品', 'ドン・キホーテ', 'ドンキ', 'カインズ']],
  ['通信費', ['ドコモ', 'DOCOMO', 'AU ', 'ソフトバンク', 'SOFTBANK', '楽天モバイル', 'AHAMO', 'POVO', 'LINEMO', 'UQ']],
  ['サブスク', ['NETFLIX', 'SPOTIFY', 'AMAZON PRIME', 'APPLE.COM', 'GOOGLE PLAY', 'YOUTUBE', 'DISNEY', 'U-NEXT', 'HULU', 'DAZN']],
  ['衣服・美容', ['ユニクロ', 'UNIQLO', 'GU ', 'ZARA', 'H&M', 'しまむら']],
];
function guessCategory(shop) {
  const s = normalize(shop).toUpperCase() + ' ';
  for (const [cat, words] of CATEGORY_RULES) {
    if (state.categories.includes(cat) && words.some(w => s.includes(w.toUpperCase()))) return cat;
  }
  return state.settings.oliveCategory;
}

/**
 * Olive（三井住友カード）ご利用通知メールを解析し、取引の配列を返す。
 * 実際の書式:
 *   Ｏｌｉｖｅ／クレジットについてカードの利用内容をお知らせします。
 *   ご利用日時：2026/11/23 15:42
 *   ファミリーマート（買物）	638円
 *   マクドナルド（取消）	-970円   ← 取消
 * 決済通知ではないメールは空配列。
 */
function parseOliveMail(rawText, subject = '', headerDate = '') {
  const t = normalize(rawText);
  const all = normalize(subject) + '\n' + t;

  // 支払い種別（「Olive/クレジット」「Olive/デビット」等の表記を優先）
  const kindM = /Olive\s*\/\s*(クレジット|デビット|ポイント払い|プリペイド)/.exec(all);
  const kind = kindM ? kindM[1] : /デビット/.test(all) ? 'デビット' : 'クレジット';
  const method = kind === 'クレジット' ? 'クレカ' : 'その他';

  const txs = [];
  const mk = (y, mo, d, hh, mm, shopRaw, amtStr) => {
    let amount = +amtStr.replace(/[,\s]/g, '');
    if (!amount) return;
    let shop = shopRaw.trim().replace(/^[:\s]+/, '');
    const typeM = /[（(]([^（）()]{1,8})[）)]\s*$/.exec(shop);
    const type = typeM ? typeM[1] : '';
    if (typeM) shop = shop.slice(0, typeM.index).trim();
    const cancel = amount < 0 || /取消|取り消し|返品|キャンセル/.test(type);
    const date = `${y}-${pad(+mo)}-${pad(+d)}`;
    txs.push({ date, dt: `${date} ${hh ? pad(+hh) + ':' + mm : '00:00'}`, shop: shop.slice(0, 60),
      amount: Math.abs(amount), cancel, type, method, kind });
  };

  // 書式A：「ご利用日時：日付」の次行に「店名（種別）<TAB>金額円」（1通に複数あっても対応）
  const reA = /ご利用日時\s*:?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?[^\n]*\n\s*([^\n]+?)\s*(-?\s*[\d,]+)\s*円/g;
  for (const m of t.matchAll(reA)) mk(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
  if (txs.length) return txs;

  // 書式B：ラベル付き（「ご利用日：」「ご利用先：」「ご利用金額：」）
  const dM = /(?:ご利用日時?|利用日|お取引日時?|取引日時?)\s*:?\s*(\d{4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/.exec(t);
  const aM = /(?:ご利用金額|利用金額|お支払(?:い)?金額|お取引金額|ご利用額)\s*:?\s*¥?\s*(-?[\d,]+)\s*円?/.exec(t);
  if (dM && aM) {
    const shop = /(?:ご利用先|利用先|ご利用店名?|加盟店名?|お支払先)\s*:?\s*([^\n]+)/.exec(t)?.[1] || '';
    mk(dM[1], dM[2], dM[3], dM[4], dM[5], shop, aM[1]);
  }
  return txs;
}

/* ---------- Gmail 同期 ---------- */
const dtDiffDays = (a, b) => (new Date(a.replace(' ', 'T')) - new Date(b.replace(' ', 'T'))) / 86400000;

// 取消を、同じ店・同じ金額で直前（7日以内）の購入と相殺する
function applyCancels(cancels, ym) {
  let netted = 0; const remain = [];
  for (const c of cancels.sort((a, b) => a.dt.localeCompare(b.dt))) {
    let best = null;
    for (const e of state.entries) {
      if (e.source !== 'olive' || e.amount !== c.amount || (e.shop || '') !== c.shop || !e.dt) continue;
      const diff = dtDiffDays(c.dt, e.dt);
      if (diff < 0 || diff > 7) continue;
      if (!best || e.dt > best.dt) best = e;
    }
    if (best) {
      state.entries = state.entries.filter(e => e !== best);
      state.mailLog[best.gmailId] = { ym: best.date.slice(0, 7), status: 'netted' };
      state.mailLog[c.gmailId] = { ym: c.ym, status: 'cancel' };
      netted++;
    } else remain.push(c);
  }
  return { netted, remain };
}

function resetOliveMonth(y, m) {
  const ym = ymKey(y, m);
  state.entries = state.entries.filter(e => !(e.source === 'olive' && e.date.startsWith(ym)));
  for (const [id, v] of Object.entries(state.mailLog)) if (v.ym === ym) delete state.mailLog[id];
  state.pendingCancels = state.pendingCancels.filter(c => c.ym !== ym);
  save(); renderAll();
}

async function syncOlive({ interactive = true, y = cur.y, m = cur.m } = {}) {
  const st = $('syncStatus'); const btn = $('syncBtn');
  btn.disabled = true; $('resyncBtn').disabled = true; st.textContent = 'Google に接続中…';
  try {
    let token = getToken();
    if (!token) token = await requestToken(interactive);

    const ym = ymKey(y, m);
    const next = new Date(y, m, 1);
    const q = `${state.settings.query} after:${y}/${pad(m)}/01 before:${next.getFullYear()}/${pad(next.getMonth() + 1)}/01`;
    st.textContent = 'メールを検索中…';
    let ids = [], pageToken = '';
    do {
      const r = await gmail(`messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? '&pageToken=' + pageToken : ''}`, token);
      ids.push(...(r.messages || []).map(x => x.id)); pageToken = r.nextPageToken || '';
    } while (pageToken && ids.length < 2000);

    const known = new Set([...state.entries.filter(e => e.gmailId).map(e => e.gmailId), ...Object.keys(state.mailLog),
      ...state.pendingCancels.map(c => c.gmailId)]);
    const todo = ids.filter(id => !known.has(id));
    let added = 0, notPayment = 0;
    const cancels = [];
    for (let i = 0; i < todo.length; i++) {
      st.textContent = `メールを解析中… ${i + 1}/${todo.length}`;
      const msg = await gmail(`messages/${todo[i]}?format=full`, token);
      const hs = msg.payload?.headers || [];
      const subject = hs.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const txs = parseOliveMail(extractText(msg.payload), subject);
      if (!txs.length) { notPayment++; state.mailLog[todo[i]] = { ym, status: 'skipped' }; continue; }
      for (const tx of txs) {
        if (tx.cancel) { cancels.push({ gmailId: todo[i], ym, dt: tx.dt, shop: tx.shop, amount: tx.amount }); continue; }
        state.entries.push({ id: uid(), date: tx.date, dt: tx.dt, amount: tx.amount, category: guessCategory(tx.shop),
          method: tx.method, shop: tx.shop, memo: tx.shop || `Olive ${tx.kind}`, source: 'olive', gmailId: todo[i] });
        added++;
      }
    }
    // 今回の取消 ＋ 以前から保留中の取消をまとめて相殺
    const { netted, remain } = applyCancels([...state.pendingCancels, ...cancels], ym);
    state.pendingCancels = remain;
    save(); renderAll();

    const lines = [`完了：${ids.length}件のメールを確認し、${added}件の決済を追加しました`];
    if (ids.length - todo.length) lines.push(`・${ids.length - todo.length}件は取り込み済み`);
    if (netted) lines.push(`・取消 ${netted}件を元の決済と相殺しました`);
    if (remain.length) lines.push(`・元の決済が見つからない取消が${remain.length}件あります（見つかり次第相殺します）`);
    if (notPayment) lines.push(`・${notPayment}件は決済通知ではないため対象外です`);
    st.textContent = lines.join('\n');
    if (added || netted) toast(`Olive：${added}件追加${netted ? `・${netted}件相殺` : ''}`);
  } catch (err) {
    st.textContent = '同期できませんでした：' + err.message;
  } finally { btn.disabled = false; $('resyncBtn').disabled = false; }
}

/* ---------- 起動 ---------- */
setupNav(); setupForms(); setupSettings(); renderAll();
$('syncBtn').onclick = () => syncOlive({ interactive: true });
$('resyncBtn').onclick = () => {
  if (!confirm(`${cur.y}年${cur.m}月の Olive 取り込み分を削除して、もう一度取り込みますか？\n（手入力のデータは消えません）`)) return;
  resetOliveMonth(cur.y, cur.m); syncOlive({ interactive: true });
};
window.addEventListener('load', () => {
  if (state.settings.autoSync && state.settings.clientId) {
    const now = new Date();
    // トークンが残っていれば即同期。無ければ Google のサイレント認証を試みる
    setTimeout(() => syncOlive({ interactive: false, y: now.getFullYear(), m: now.getMonth() + 1 }), 800);
  }
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!$('tab-chart').hidden) renderCharts(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// テスト用に公開
window.__kakeibo = { parseOliveMail, guessCategory, get state() { return state; } };
