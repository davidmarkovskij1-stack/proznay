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
const PACK_EMOJI = { classic: '🎯', party: '🎉' };

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

async function api(path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData || '', ...(body || {}) }),
    });
  } catch (e) {
    throw new Error('Нет связи с сервером. Проверь интернет и открой заново.');
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
  return `https://t.me/${BOT}/app?startapp=${quizId}`;
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
}

function bindPackCards() {
  document.querySelectorAll('#scr-pack .pack-card:not(.soon)').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#scr-pack .pack-card').forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
      state.pack = card.dataset.pack;
      haptic('light');
    });
  });
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
    b.innerHTML = `<span class="dot"></span><span>${esc(opt)}</span>`;
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
async function openTakeIntro(quizId) {
  show('take-intro');
  $('#take-intro-name').textContent = 'Загрузка…';
  try {
    const res = await fetch(`${API}/api/quiz/take?id=${encodeURIComponent(quizId)}`);
    const data = await res.json();
    if (!data.ok) throw new Error('Квиз не найден — возможно, ссылка устарела');
    state.takeQuiz = data.quiz;
    state.takePicks = [];
    state.takeVotes = [];
    $('#take-intro-name').textContent = data.quiz.creator_name || 'Друг';
  } catch (e) {
    toast(e.message);
    show('welcome');
  }
}

function renderTakeQ(i) {
  const q = state.takeQuiz.questions[i];
  $('#take-count').textContent = `Вопрос ${i + 1} из 7`;
  $('#take-bar').style.width = `${(i / 7) * 100}%`;
  $('#take-question').textContent = q.q;
  const box = $('#take-opts');
  box.innerHTML = '';
  q.opts.forEach((opt, oi) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="dot"></span><span>${esc(opt)}</span>`;
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
    b.innerHTML = `<span class="dot"></span><span>${esc(opt)}</span>`;
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
    const emoji = PACK_EMOJI[q.pack] || '🎯';
    const d = new Date(q.created_at);
    const dateStr = `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    const sub = q.takers > 0
      ? `${q.takers} ${plural(q.takers, 'человек прошёл', 'человека прошли', 'человек прошли')} · лид: ${esc(q.top_name)} ${q.top_pct}%`
      : 'Ждёт друзей…';
    return `
      <div class="quiz-item" data-id="${esc(q.id)}">
        <div class="q-emoji">${emoji}</div>
        <div class="meta">
          <div class="title">Квиз от ${dateStr}</div>
          <div class="sub">${sub}</div>
        </div>
        <div class="arrow">›</div>
      </div>`;
  }).join('') + `<button class="link-btn" id="btn-open-settings">Настройки уведомлений →</button>`;

  list.querySelectorAll('.quiz-item').forEach((item) => {
    item.addEventListener('click', () => openBoard(item.dataset.id));
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
    html += `<div class="board-list mt12">` + q.leaderboard.map((r) => {
      const cls = r.place === 1 ? 'p1' : r.place === 2 ? 'p2' : r.place === 3 ? 'p3' : '';
      return `
        <div class="board-row ${cls}">
          <div class="place">${r.place}</div>
          <div class="col">
            <div class="name">${esc(r.name)}</div>
            <div class="bar"><div style="width:${r.pct}%"></div></div>
          </div>
          <div class="pct">${r.pct}%</div>
        </div>`;
    }).join('') + `</div>`;
  }

  // голосования: агрегаты
  if (q.votes_agg && q.votes_agg.length) {
    html += `<div class="h3 mt24">Что друзья думают о тебе 🤫</div>`;
    html += `<div class="vote-agg mt12">` + q.votes_agg.map((v) => {
      if (!v.top) return `<div class="chip"><span>${esc(v.q)}</span><span class="pct">—</span></div>`;
      return `<div class="chip"><span>${esc(v.q)}</span><span class="pct">${esc(v.opts[v.top.idx])} · ${v.top.share}%</span></div>`;
    }).join('') + `</div>`;
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
        ? q.votes.map((v, i) => d.votes[i] != null ? `<div class="kv"><span class="q">${esc(v.q)}</span><span>${esc(v.opts[d.votes[i]])}</span></div>` : '').join('')
        : '';
      return `
        <div class="detail-row" data-i="${di}">
          <div class="detail-head"><span>${esc(d.name)} · ${d.pct}%</span><span class="dim">›</span></div>
          <div class="detail-body">${answers}${votes ? `<div class="hr"></div>${votes}` : ''}</div>
        </div>`;
    }).join('');
  } else if (q.leaderboard.length) {
    const names = q.leaderboard.slice(0, 3).map((r) => esc(r.name));
    html += `
      <div class="card mt24 paywall-teaser">
        <div class="teaser-rows">
          ${names.map((n) => `<div class="teaser-row"><span>${n}</span><span>«Кот 🐈»</span></div>`).join('')}
        </div>
      </div>
      <div class="stars-card mt16">
        <div class="h3">Узнай всё, что о тебе ответили</div>
        <div class="sub small mt8" style="color:rgba(255,255,255,.85)">Кто назвал тебя капибарой? Кто оценил энергию на 10? И кто на какие вопросы ошибся.</div>
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
      const data = await api('/api/settings', { muted: !enable });
      toast(enable ? 'Уведомления включены 🔔' : 'Уведомления выключены 🔕');
    } catch (e) {
      sw.classList.toggle('on', !enable);
      toast(e.message);
    }
  };
}

/* ---------- старт ---------- */
function bindButtons() {
  $('#btn-create').addEventListener('click', openPack);
  $('#btn-my-quizzes').addEventListener('click', () => openMy());
  $('#btn-how').addEventListener('click', () => show('how'));
  $('#btn-how-create').addEventListener('click', openPack);
  $('#btn-pack-next').addEventListener('click', startCreate);
  $('#btn-send-friends').addEventListener('click', () => {
    if (!state.shareInfo) return;
    shareTo(state.createQuiz.id, state.shareInfo.text);
  });
  $('#btn-copy-link').addEventListener('click', async () => {
    if (!state.shareInfo) return;
    const ok = await copyText(state.shareInfo.url);
    toast(ok ? 'Ссылка скопирована 🔗' : 'Не получилось скопировать');
  });
  $('#btn-go-board').addEventListener('click', () => openBoard(state.createQuiz.id));
  $('#btn-take-start').addEventListener('click', () => renderTakeQ(0));
  $('#btn-res-create').addEventListener('click', openPack);
  $('#btn-board-share').addEventListener('click', () => {});
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

  bindPackCards();
  bindButtons();

  show('splash');
  const sp = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) ||
             new URLSearchParams(location.search).get('startapp') || '';

  try {
    const data = await api('/api/session');
    state.user = data.user;
  } catch (e) {
    // без авторизации показываем welcome с ошибкой при действиях
  }

  if (sp === 'create') openPack();
  else if (sp === 'my') openMy();
  else if (/^[A-Za-z0-9_-]{6,12}$/.test(sp)) openTakeIntro(sp);
  else show('welcome');
}

boot();
