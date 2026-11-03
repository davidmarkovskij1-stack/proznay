'use strict';
/* Прознай — логика Mini App */

const tg = window.Telegram.WebApp;
const API = window.PROZNAY_API_URL;
let BOT = window.PROZNAY_BOT_USERNAME || 'proznay_bot';

const state = {
  user: null,
  pack: 'classic',
  createQuiz: null,   // {id, questions, votes}
  createAnswers: [],
  shareInfo: null,    // {url, text}
  takeQuiz: null,     // {id, creator_name, questions, votes}
  takePicks: [],
  takeVotes: [],
  takeResult: null,
  boardQuiz: null,
  boardId: null,
};

const RING_C = 2 * Math.PI * 84;
const PACK_META = {
  classic: ['🎯', 'Классика'],
  party: ['🎉', 'Вечеринка'],
  love: ['💘', 'Романтика'],
  school: ['🎒', 'Школа и универ'],
  truth: ['🌶', 'Горькая правда'],
  roast: ['🤡', 'Кринж и ляпы'],
  adult: ['🌙', 'После полуночи'],
};

/* ---------- утилиты ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function haptic(kind) {
  try { tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {}
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch с ретраями: бесплатный сервер иногда «просыпается» 30–60 секунд */
async function fetchRetry(url, opts, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        toast(`Сервер просыпается… попытка ${i + 2} из ${attempts} 🌙`);
        await sleep(5000 * (i + 1));
      }
    }
  }
  throw new Error('Сервер не отвечает. Он бесплатный и иногда спит — открой бота через минуту 🌙');
}

async function api(path, body) {
  let res;
  try {
    res = await fetchRetry(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData || '', ...(body || {}) }),
    });
  } catch (e) {
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.message || data.error || 'Что-то сломалось');
    err.code = data.error;
    throw err;
  }
  return data;
}

function botLink(quizId) {
  // deep link на бота с payload: получателю приходит вызов от бота
  return `https://t.me/${BOT}?start=${quizId}`;
}

function shareTo(quizId, text) {
  const url = `https://t.me/share/url?url=${encodeURIComponent(botLink(quizId))}&text=${encodeURIComponent(text || '')}`;
  tg.openTelegramLink(url);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }
}

/* ---------- навигация ---------- */
const BACK_MAP = {
  'how': () => show('welcome'),
  'pack': () => show('welcome'),
  'create': () => show('pack'),
  'share': () => openMy(true),
  'my': () => show('welcome'),
  'board': () => openMy(true),
  'settings': () => openMy(true),
  'claim': () => show('settings'),
  'take-intro': () => tg.close(),
  'result': () => tg.close(),
};

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('#scr-' + id);
  if (el) el.classList.add('active');
  state.current = id;
  window.scrollTo(0, 0);
  const back = BACK_MAP[id];
  try {
    if (back) {
      tg.BackButton.show();
    } else {
      tg.BackButton.hide();
    }
  } catch (e) {}
}

tg.BackButton.onClick(() => {
  const back = BACK_MAP[state.current];
  if (back) back();
});

/* ---------- создание квиза ---------- */
function openPack() {
  show('pack');
  renderPackList();
}

async function loadPacks() {
  try {
    const data = await api('/api/packs');
    state.packs = data.packs;
  } catch (e) {
    state.packs = Object.entries(PACK_META).map(([code, [emoji, title]]) => ({
      code, emoji, title, desc: '', price: 0, owned: true, adult: false,
    }));
  }
}

function renderPackList() {
  const box = $('#pack-list');
  if (!box) return;
  if (!state.packs.length) {
    box.innerHTML = '<div class="spin"></div>';
    loadPacks().then(renderPackList);
    return;
  }
  box.innerHTML = state.packs.map((p) => {
    const sel = p.code === state.pack ? ' sel' : '';
    const locked = !p.owned;
    const right = locked
      ? `<div class="pack-lock">🔒 ${p.price} ⭐</div>`
      : (p.price > 0 ? '<div class="pack-open">Открыт ✓</div>' : '');
    return `
      <div class="pack-card${sel}" data-pack="${esc(p.code)}" data-locked="${locked ? 1 : 0}">
        <div class="emoji">${esc(p.emoji)}</div>
        <div>
          <div class="h3">${esc(p.title)}${p.adult ? ' <span class="badge-18">18+</span>' : ''}</div>
          <div class="sub small">${esc(p.desc || '')}</div>
        </div>
        ${right}
      </div>`;
  }).join('');

  box.querySelectorAll('.pack-card').forEach((card) => {
    card.addEventListener('click', () => {
      const code = card.dataset.pack;
      if (card.dataset.locked === '1') return buyPack(code);
      box.querySelectorAll('.pack-card').forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
      state.pack = code;
      haptic('light');
    });
  });
}

async function buyPack(code) {
  const p = state.packs.find((x) => x.code === code);
  if (!p) return;
  if (p.adult) {
    const ok18 = await new Promise((r) => {
      try { tg.showConfirm('Тебе есть 18 лет? Пак содержит взрослые вопросы.', r); } catch (e) { r(true); }
    });
    if (!ok18) { toast('Пак останется закрытым 🔒'); return; }
  }
  toast('Открываем оплату…');
  try {
    const data = await api('/api/pack/buy', { pack: code });
    if (data.already) { await loadPacks(); renderPackList(); return; }
    const onClosed = async (e) => {
      tg.offEvent('invoiceClosed', onClosed);
      if (e && e.status === 'paid') {
        try { await api('/api/payments/confirm', { payload: data.payload }); } catch (err) {}
        toast(`Пак «${p.title}» открыт! 🎉`);
        await loadPacks();
        state.pack = code;
        renderPackList();
      }
    };
    tg.onEvent('invoiceClosed', onClosed);
    tg.openInvoice(data.invoice_link);
  } catch (e) {
    toast(e.message);
  }
}

async function startCreate() {
  const btn = $('#btn-pack-next');
  btn.disabled = true;
  btn.textContent = 'Собираем квиз…';
  try {
    const data = await api('/api/quiz/create', { pack: state.pack });
    state.createQuiz = data.quiz;
    state.createAnswers = [];
    renderCreateQ(0);
    show('create');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Собрать квиз ✨';
  }
}

function renderCreateQ(i) {
  const q = state.createQuiz.questions[i];
  $('#create-count').textContent = `Вопрос ${i + 1} из 7`;
  $('#create-bar').style.width = `${(i / 7) * 100}%`;
  $('#create-question').textContent = q.q;
  const box = $('#create-opts');
  box.innerHTML = '';
  q.opts.forEach((opt, oi) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="dot">${oi + 1}</span><span>${esc(opt)}</span>`;
    b.addEventListener('click', () => {
      haptic('light');
      state.createAnswers[i] = oi;
      box.querySelectorAll('.opt').forEach((o) => o.classList.remove('sel'));
      b.classList.add('sel');
      setTimeout(() => {
        if (i + 1 < 7) renderCreateQ(i + 1);
        else finishCreate();
      }, 180);
    });
    box.appendChild(b);
  });
}

async function finishCreate() {
  $('#create-question').textContent = 'Секунду…';
  $('#create-opts').innerHTML = '';
  try {
    const data = await api('/api/quiz/key', { quiz_id: state.createQuiz.id, answers: state.createAnswers });
    state.shareInfo = data.share;
    $('#share-name').textContent = `${state.user ? state.user.name : 'Твой'} квиз готов ловить друзей`;
    show('share');
  } catch (e) {
    toast(e.message);
    show('pack');
  }
}

/* ---------- прохождение ---------- */
/** Универсальное открытие по ссылке квиза: создатель → рейтинг, друг → тест */
async function openStart(quizId) {
  show('take-intro');
  $('#take-intro-name').textContent = 'Загрузка…';
  try {
    const res = await fetchRetry(`${API}/api/quiz/take?id=${encodeURIComponent(quizId)}`, { method: 'GET' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Квиз не найден — возможно, ссылка устарела');
    const meId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null;
    if (meId && String(data.quiz.creator_id) === String(meId)) {
      return openBoard(quizId);
    }
    state.takeQuiz = data.quiz;
    state.takePicks = [];
    state.takeVotes = [];
    const nm = data.quiz.creator_name || 'Друг';
    $('#take-intro-name').textContent = nm;
    const av = $('#take-intro-avatar');
    if (av) av.textContent = String(nm).trim().charAt(0).toUpperCase() || '👁';
    show('take-intro');
  } catch (e) {
    toast(e.message);
    show('welcome');
  }
}

function renderTakeQ(i) {
  show('take');
  const q = state.takeQuiz.questions[i];
  $('#take-count').textContent = `Вопрос ${i + 1} из 7`;
  $('#take-bar').style.width = `${(i / 7) * 100}%`;
  $('#take-question').textContent = q.q;
  const box = $('#take-opts');
  box.innerHTML = '';
  q.opts.forEach((opt, oi) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="dot">${oi + 1}</span><span>${esc(opt)}</span>`;
    b.addEventListener('click', () => {
      haptic('light');
      state.takePicks[i] = oi;
      box.querySelectorAll('.opt').forEach((o) => o.classList.remove('sel'));
      b.classList.add('sel');
      setTimeout(() => {
        if (i + 1 < 7) renderTakeQ(i + 1);
        else renderVotesQ(0);
      }, 180);
    });
    box.appendChild(b);
  });
}

function renderVotesQ(i) {
  const v = state.takeQuiz.votes[i];
  show('votes');
  $('#votes-count').textContent = `Анонимно ${i + 1} из 3`;
  $('#votes-bar').style.width = `${(i / 3) * 100}%`;
  $('#votes-question').textContent = v.q;
  const box = $('#votes-opts');
  box.innerHTML = '';
  v.opts.forEach((opt, oi) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="dot">${oi + 1}</span><span>${esc(opt)}</span>`;
    b.addEventListener('click', () => {
      haptic('light');
      state.takeVotes[i] = oi;
      box.querySelectorAll('.opt').forEach((o) => o.classList.remove('sel'));
      b.classList.add('sel');
      setTimeout(() => {
        if (i + 1 < 3) renderVotesQ(i + 1);
        else submitTake();
      }, 180);
    });
    box.appendChild(b);
  });
}

async function submitTake() {
  toast('Считаем результат…');
  try {
    const data = await api('/api/quiz/submit', {
      quiz_id: state.takeQuiz.id,
      picks: state.takePicks,
      votes: state.takeVotes,
    });
    state.takeResult = data;
    renderResult(data, state.takeQuiz.creator_name);
    show('result');
  } catch (e) {
    if (e.code === 'self') {
      toast(e.message);
      show('welcome');
      return;
    }
    toast(e.message);
    show('take-intro');
  }
}

function renderResult(data, creatorName) {
  const pct = data.pct || 0;
  const ring = $('#ring');
  ring.style.strokeDashoffset = RING_C;
  const num = $('#res-pct');
  num.textContent = '0';
  $('#res-lvl').textContent = `${data.level ? data.level.emoji + ' ' : ''}${data.level ? data.level.title : ''}`;
  setTimeout(() => { ring.style.strokeDashoffset = RING_C * (1 - pct / 100); }, 60);

  const t0 = performance.now();
  const dur = 1100;
  function tick(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    num.textContent = Math.round(eased * pct);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  const confetti = $('#confetti');
  if (confetti) {
    confetti.innerHTML = '';
    if (pct >= 57) {
      const colors = ['#7c5cff', '#ff6ec7', '#4ade80', '#ffd166', '#7dd3fc'];
      for (let i = 0; i < 28; i++) {
        const s = document.createElement('i');
        s.style.left = (50 + (Math.random() * 90 - 45)) + '%';
        s.style.background = colors[i % colors.length];
        s.style.animationDelay = (Math.random() * 0.9) + 's';
        s.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
        s.style.width = s.style.height = (5 + Math.random() * 6) + 'px';
        confetti.appendChild(s);
      }
      setTimeout(() => { confetti.innerHTML = ''; }, 3600);
    }
  }

  const placeEl = $('#res-place');
  if (data.place && data.total) {
    placeEl.textContent = `Ты на ${data.place} месте из ${data.total}`;
  } else {
    placeEl.textContent = '';
  }

  const hint = $('#res-hint');
  if (data.already) {
    hint.textContent = 'Ты уже отвечал(а) в этом квизе — показываем прошлый результат.';
  } else if (pct >= 85) {
    hint.textContent = `${creatorName} может доверить тебе что угодно.`;
  } else if (pct >= 57) {
    hint.textContent = 'Неплохо! Но есть, куда расти 🙂';
  } else {
    hint.textContent = `Хм… стоит пообщаться с ${creatorName} побольше 😄`;
  }

  const btnShare = $('#btn-res-share');
  btnShare.onclick = () => {
    shareTo(state.takeQuiz.id,
      `Я знаю ${creatorName} на ${pct}% 👁 Побьёшь мой результат?`);
  };
}

/* ---------- мои квизы ---------- */
async function openMy(silent) {
  show('my');
  const list = $('#my-list');
  if (!silent) list.innerHTML = '<div class="spin"></div>';
  try {
    const data = await api('/api/session');
    state.user = data.user;
    renderMyList(data.quizzes);
  } catch (e) {
    list.innerHTML = `<div class="card center"><div class="sub">${esc(e.message)}</div></div>`;
  }
}

function renderMyList(quizzes) {
  const list = $('#my-list');
  if (!quizzes || !quizzes.length) {
    list.innerHTML = `
      <div class="card center">
        <div class="emoji-big">👀</div>
        <div class="h3 mt12">Пока пусто</div>
        <div class="sub small mt8">Создай первый квиз — и узнай, кто из друзей знает тебя лучше всех</div>
        <button class="btn mt16" id="btn-my-empty-create">🎮 Создать квиз</button>
      </div>`;
    const b = $('#btn-my-empty-create');
    if (b) b.addEventListener('click', openPack);
    return;
  }
  list.innerHTML = quizzes.map((q) => {
    const [emoji, title] = PACK_META[q.pack] || ['🎯', 'Классика'];
    const d = new Date(q.created_at);
    const dateStr = `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    const sub = q.takers > 0
      ? `${dateStr} · ${q.takers} ${plural(q.takers, 'человек прошёл', 'человека прошли', 'человек прошли')} · лид: ${esc(q.top_name)} ${q.top_pct}%`
      : `${dateStr} · ждёт друзей…`;
    return `
      <div class="quiz-item" data-id="${esc(q.id)}">
        <div class="q-emoji">${emoji}</div>
        <div class="meta">
          <div class="title">${esc(title)}</div>
          <div class="sub">${sub}</div>
        </div>
        <div class="arrow">›</div>
      </div>`;
  }).join('') + `<button class="link-btn" id="btn-open-settings">Настройки и награды →</button>`;

  list.querySelectorAll('.quiz-item').forEach((item) => {
    const id = item.dataset.id;
    let lpTimer = null;
    const startLp = () => {
      lpTimer = setTimeout(async () => {
        lpTimer = null;
        haptic('heavy');
        let ok = true;
        try { ok = await new Promise((r) => tg.showConfirm('Удалить квиз? Ответы друзей сотрутся навсегда.', r)); } catch (e) {}
        if (!ok) return;
        try {
          await api('/api/quiz/delete', { quiz_id: id });
          item.dataset.deleted = '1';
          toast('Квиз удалён 🗑');
          openMy(true);
        } catch (e) { toast(e.message); }
      }, 600);
    };
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    item.addEventListener('touchstart', startLp, { passive: true });
    item.addEventListener('touchend', cancelLp);
    item.addEventListener('touchmove', cancelLp);
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); startLp(); });
    item.addEventListener('click', () => { if (!item.dataset.deleted) openBoard(id); });
  });
  const s = $('#btn-open-settings');
  if (s) s.addEventListener('click', openSettings);
}

/* ---------- лидерборд ---------- */
async function openBoard(quizId) {
  state.boardId = quizId;
  show('board');
  $('#board-body').innerHTML = '<div class="spin"></div>';
  $('#board-title').textContent = 'Рейтинг';
  $('#board-sub').textContent = '';
  try {
    const data = await api('/api/quiz/results', { quiz_id: quizId });
    state.boardQuiz = data.quiz;
    renderBoard();
  } catch (e) {
    $('#board-body').innerHTML = `<div class="card center"><div class="sub">${esc(e.message)}</div></div>`;
  }
}

function renderBoard() {
  const q = state.boardQuiz;
  $('#board-sub').textContent = `${q.leaderboard.length} ${plural(q.leaderboard.length, 'друг прошёл', 'друга прошли', 'друзей прошли')}`;

  $('#btn-board-share').onclick = () => shareTo(q.id, q.share && q.share.text ? q.share.text + ' 👇' : 'Пройди квиз обо мне 👇');

  let html = '';

  if (!q.leaderboard.length) {
    html += `
      <div class="card center mt12">
        <div class="emoji-big">🥺</div>
        <div class="h3 mt12">Рейтинг пока пустой</div>
        <div class="sub small mt8">Одно сообщение в чат — и результаты полетят</div>
      </div>`;
  } else {
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    html += `<div class="board-list mt12">` + q.leaderboard.map((r) => {
      const cls = r.place === 1 ? 'p1' : r.place === 2 ? 'p2' : r.place === 3 ? 'p3' : '';
      const medal = medals[r.place] || '';
      const initial = esc(String(r.name || '?').trim().charAt(0).toUpperCase() || '?');
      return `
        <div class="board-row ${cls}">
          <div class="avatar">${initial}</div>
          <div class="col">
            <div class="name">${medal ? medal + ' ' : ''}${esc(r.name)}</div>
            <div class="bar"><div style="width:${r.pct}%"></div></div>
          </div>
          <div class="pct">${r.pct}%</div>
        </div>`;
    }).join('') + `</div>`;
  }

  // секретные голосования: агрегаты + интрига
  if (q.votes_agg && q.votes_agg.length) {
    html += `<div class="h3 mt24">🤫 Секретные голосования</div>`;
    html += `<div class="sub small mt8">Друзья отвечали анонимно. Общее видно всем — но кто именно сказал…</div>`;
    html += `<div class="vote-agg mt12">` + q.votes_agg.map((v) => {
      if (!v.top) return `<div class="chip"><span>${esc(v.q)}</span><span class="pct">—</span></div>`;
      return `<div class="chip"><span>${esc(v.q)}</span><span class="pct">${esc(v.opts[v.top.idx])} · ${v.top.share}%</span></div>`;
    }).join('') + `</div>`;
    if (!q.details) html += `<div class="sub small mt8 intrigue">Кто назвал тебя капибарой — узнаешь после раскрытия 👀</div>`;
  }

  // раскрытие
  if (q.details) {
    html += `<div class="h3 mt24">Кто что ответил 🔓</div>`;
    html += q.details.map((d, di) => {
      const dots = d.picks.map((p, i) => `<i class="${p === q.key[i] ? 'hit' : ''}"></i>`).join('');
      const answers = q.questions.map((qq, i) =>
        `<div class="kv"><span class="q">${esc(qq.q)}</span><span>${esc(qq.opts[d.picks[i]])}${d.picks[i] === q.key[i] ? ' ✅' : ` <span class="dim">(верно: ${esc(qq.opts[q.key[i]])})</span>`}</span></div>`
      ).join('');
      const votes = d.votes.length && q.votes
        ? `<div class="sub small mt8" style="font-weight:700">Секретные ответы:</div>` + q.votes.map((v, i) => d.votes[i] != null ? `<div class="kv"><span class="q">${esc(v.q)}</span><span>${esc(v.opts[d.votes[i]])}</span></div>` : '').join('')
        : '';
      return `
        <div class="detail-row" data-i="${di}">
          <div class="detail-head"><span>${esc(d.name)} · ${d.pct}%</span><span class="dim">›</span></div>
          <div class="detail-body">${answers}${votes ? `<div class="hr"></div>${votes}` : ''}</div>
        </div>`;
    }).join('');
  } else if (q.leaderboard.length) {
    const names = q.leaderboard.slice(0, 4).map((r) => esc(r.name));
    const tops = (q.votes_agg || []).filter((v) => v.top).slice(0, 4);
    const teaserRows = tops.length
      ? tops.map((v, i) => `<div class="teaser-row"><span>${names[i % Math.max(1, names.length)]}</span><span>${esc(v.opts[v.top.idx])}</span></div>`).join('')
      : names.map((n) => `<div class="teaser-row"><span>${n}</span><span>«…»</span></div>`).join('');
    html += `
      <div class="card mt24 paywall-teaser">
        <div class="teaser-rows">${teaserRows}</div>
      </div>
      <div class="stars-card mt16">
        <div class="h3">Кто это сказал? 👀</div>
        <div class="sub small mt8" style="color:rgba(255,255,255,.85)">Кто назвал тебя капибарой? Какую энергию дал каждый друг? И кто на что ответил в самом квизе.</div>
        <button class="btn" id="btn-reveal">Раскрыть за ${q.stars} ⭐</button>
        <div class="small center mt12" style="color:rgba(255,255,255,.65)">Оплата звёздами Telegram · безопасно</div>
      </div>`;
  }

  $('#board-body').innerHTML = html;

  // обработчики
  document.querySelectorAll('#board-body .detail-head').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
  const revealBtn = $('#btn-reveal');
  if (revealBtn) revealBtn.addEventListener('click', doReveal);
}

async function doReveal() {
  const btn = $('#btn-reveal');
  if (!btn || !state.boardQuiz) return;
  btn.disabled = true;
  btn.textContent = 'Открываем оплату…';
  try {
    const data = await api('/api/quiz/reveal', { quiz_id: state.boardId });
    if (data.already) {
      await refreshBoard();
      return;
    }
    const onClosed = async (e) => {
      tg.offEvent('invoiceClosed', onClosed);
      if (e && e.status === 'paid') {
        const me = tg.initDataUnsafe && tg.initDataUnsafe.user;
        try {
          await api('/api/payments/confirm', { payload: `reveal:${state.boardId}:${me ? me.id : ''}` });
        } catch (err) {}
        toast('Оплачено! Раскрываем 🔓');
        await refreshBoard();
      } else {
        btn.disabled = false;
        btn.textContent = `Раскрыть за ${state.boardQuiz.stars} ⭐`;
      }
    };
    tg.onEvent('invoiceClosed', onClosed);
    tg.openInvoice(data.invoice_link);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = `Раскрыть за ${state.boardQuiz.stars} ⭐`;
  }
}

async function refreshBoard() {
  try {
    const data = await api('/api/quiz/results', { quiz_id: state.boardId });
    state.boardQuiz = data.quiz;
    renderBoard();
  } catch (e) {}
}

/* ---------- настройки ---------- */
async function openSettings() {
  show('settings');
  const sw = $('#sw-notif');
  sw.classList.toggle('on', state.user ? !state.user.muted : true);
  sw.onclick = async () => {
    const enable = !sw.classList.contains('on');
    sw.classList.toggle('on', enable);
    haptic('light');
    try {
      await api('/api/settings', { muted: !enable });
      toast(enable ? 'Уведомления включены 🔔' : 'Уведомления выключены 🔕');
    } catch (e) {
      sw.classList.toggle('on', !enable);
      toast(e.message);
    }
  };
  // донат-кнопки привязаны глобально (bindDonate при старте)

  // награда за донат?
  try {
    const st = await api('/api/donate/status');
    const rc = $('#rewards-card');
    if (rc) {
      rc.style.display = st.unclaimed > 0 ? '' : 'none';
      const sub = $('#rewards-sub');
      if (sub && st.unclaimed > 0) {
        sub.textContent = `У тебя ${st.unclaimed} ${plural(st.unclaimed, 'награда ждёт', 'награды ждут', 'наград ждут')}: ${st.amounts.join(' + ')} ⭐`;
      }
    }
  } catch (e) {}
}

/* ---------- награды за донат ---------- */
function confirm18() {
  return new Promise((r) => {
    try { tg.showConfirm('Тебе есть 18 лет? Пак содержит взрослые вопросы.', r); } catch (e) { r(true); }
  });
}

async function runClaim(packs) {
  const data = await api('/api/donate/claim', { packs: packs || [] });
  const granted = data.granted || [];
  if (data.mecenat) {
    toast('Ты — Меценат 💎 Все паки открыты навсегда!');
  } else if (granted.length) {
    toast(`Открыто: ${granted.map((g) => g.emoji + ' ' + g.title).join(', ')} 🎉`);
  } else {
    toast('Все паки уже открыты 😎');
  }
  await loadPacks();
  return granted;
}

function renderClaimList() {
  const locked = state.packs.filter((p) => p.price > 0 && !p.owned);
  const list = $('#claim-list');
  if (!list) return;
  if (!locked.length) {
    list.innerHTML = '<div class="card center"><div class="sub small">Все платные паки уже открыты 😎<br>Награда конвертируется в них автоматически.</div></div>';
    const apply = $('#btn-claim-apply');
    if (apply) apply.style.display = 'none';
    return;
  }
  const apply = $('#btn-claim-apply');
  if (apply) apply.style.display = '';
  const maxPick = state.claimAmounts.some((a) => a >= 50) ? 2 : 1;
  $('#claim-sub').textContent = maxPick === 2
    ? 'Выбери два пака, которые открыть:'
    : 'Выбери пак, который открыть:';
  list.innerHTML = locked.map((p) => `
    <div class="pack-card claim-card" data-pack="${esc(p.code)}">
      <div class="emoji">${esc(p.emoji)}</div>
      <div><div class="h3">${esc(p.title)}${p.adult ? ' <span class="badge-18">18+</span>' : ''}</div>
      <div class="sub small">${esc(p.desc || '')}</div></div>
      <div class="claim-check">✓</div>
    </div>`).join('');

  list.querySelectorAll('.claim-card').forEach((card) => {
    card.addEventListener('click', () => {
      const code = card.dataset.pack;
      const idx = state.claimPacks.indexOf(code);
      if (idx >= 0) {
        state.claimPacks.splice(idx, 1);
        card.classList.remove('sel');
      } else {
        if (state.claimPacks.length >= maxPick) {
          toast(`Можно выбрать максимум ${maxPick}`);
          return;
        }
        state.claimPacks.push(code);
        card.classList.add('sel');
      }
      haptic('light');
    });
  });
}

async function openClaimFlow() {
  try {
    const st = await api('/api/donate/status');
    if (!st.unclaimed) { toast('Наград уже нет 😅'); return; }
    state.claimAmounts = st.amounts;

    // 100⭐ → меценат сразу; 25⭐ → сюрприз; 50⭐ → выбор двух
    if (st.amounts.some((a) => a >= 100) || st.amounts.every((a) => a < 50)) {
      const granted = await runClaim([]);
      $('#rewards-card').style.display = 'none';
      if (st.amounts.every((a) => a < 50) && granted.length) {
        const g = granted[0];
        toast(`🎁 Сюрприз: выпал пак «${g.title}» ${g.emoji}!`);
      }
      return;
    }

    state.claimPacks = [];
    show('claim');
    await loadPacks();
    renderClaimList();
  } catch (e) {
    toast(e.message);
  }
}

async function applyClaim() {
  const apply = $('#btn-claim-apply');
  if (apply) { apply.disabled = true; apply.textContent = 'Открываем…'; }
  try {
    await runClaim(state.claimPacks);
    $('#rewards-card').style.display = 'none';
    show('settings');
  } catch (e) {
    toast(e.message);
  } finally {
    if (apply) { apply.disabled = false; apply.textContent = 'Забрать награду ✨'; }
  }
}

/* ---------- старт ---------- */
function bindButtons() {
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };
  on('btn-create', openPack);
  on('btn-my-quizzes', () => openMy());
  on('btn-how', () => show('how'));
  on('btn-how-create', openPack);
  on('btn-pack-next', startCreate);
  on('btn-send-friends', () => {
    if (!state.shareInfo) return;
    shareTo(state.createQuiz.id, state.shareInfo.text);
  });
  on('btn-copy-link', async () => {
    if (!state.shareInfo) return;
    const ok = await copyText(state.shareInfo.url);
    toast(ok ? 'Ссылка скопирована 🔗' : 'Не получилось скопировать');
  });
  on('btn-go-board', () => openBoard(state.createQuiz.id));
  on('btn-take-start', () => renderTakeQ(0));
  on('btn-res-create', openPack);
  on('btn-claim-open', openClaimFlow);
  on('btn-claim-apply', applyClaim);
  on('btn-claim-later', () => show('settings'));
}

async function boot() {
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor('#0a0a12');
    tg.setBackgroundColor('#0a0a12');
  } catch (e) {}

  // подтягиваем username бота с сервера (фолбэк — config.js)
  try {
    const res = await fetch(`${API}/api/config`);
    const cfg = await res.json();
    if (cfg && cfg.ok && cfg.bot_username) BOT = cfg.bot_username;
  } catch (e) {}

  loadPacks();
  bindButtons();
  bindDonate();

  show('splash');
  const sp = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) ||
             new URLSearchParams(location.search).get('startapp') || '';

  try {
    const data = await api('/api/session');
    state.user = data.user;
  } catch (e) {
    // без авторизации показываем welcome с ошибкой при действиях
  }

  // любое первое открытие — начальный экран (даже если пришли по «создать»)
  if (sp === 'my') openMy();
  else if (/^[A-Za-z0-9_-]{6,24}$/.test(sp)) openStart(sp);
  else show('welcome');

  loadWelcomeExtras();
}

/* ---------- донат (все кнопки .btn-donate на любых экранах) ---------- */
function bindDonate() {
  document.querySelectorAll('.btn-donate').forEach((b) => {
    b.onclick = async () => {
      const amount = Number(b.dataset.amount);
      b.disabled = true;
      const old = b.textContent;
      b.textContent = 'Открываем счёт…';
      try {
        const data = await api('/api/donate', { amount });
        const onClosed = async (e) => {
          tg.offEvent('invoiceClosed', onClosed);
          if (e && e.status === 'paid') {
            try { await api('/api/payments/confirm', { payload: data.payload }); } catch (err) {}
            toast('Спасибо! 💜');
            await loadPacks();
            await openClaimFlow();
          }
        };
        tg.onEvent('invoiceClosed', onClosed);
        tg.openInvoice(data.invoice_link);
      } catch (e) {
        toast(e.message);
      } finally {
        b.disabled = false;
        b.textContent = old;
      }
    };
  });
}

/* ---------- воронка на welcome: соцдоказательство + тизер-карусель ---------- */
async function loadWelcomeExtras() {
  try {
    const res = await fetchRetry(`${API}/api/stats`, { method: 'GET' });
    const s = await res.json();
    if (s.ok) {
      const el = $('#wstats');
      if (el) el.textContent = `🔥 Уже создано ${s.quizzes} квизов · 💬 ${s.answers} ответов от друзей`;
    }
  } catch (e) {}

  const teasers = [
    'Тебя назвали капибарой 🦫',
    'Твоя энергия: ураган 24/7 ⚡',
    '3 друга считают тебя душой компании 💜',
    'Твой вайб в чате: мем-канал в одном лице 😂',
    'Суперспособность от друзей: творческий хаос 🎨',
  ];
  let ti = 0;
  const t = $('#wteaser');
  if (t) {
    setInterval(() => {
      ti = (ti + 1) % teasers.length;
      t.style.opacity = 0;
      setTimeout(() => { t.textContent = teasers[ti]; t.style.opacity = 1; }, 240);
    }, 3400);
  }
}

boot();
