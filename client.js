(() => {
  // Example name in the name box: a random common British or US first name.
  const EXAMPLE_NAMES = ['Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Poppy', 'Alfie', 'Freya', 'Jack', 'Ella', 'Ethan', 'Madison', 'Tyler', 'Hannah', 'Logan', 'Avery', 'Mason', 'Chloe', 'Carter', 'Brooke'];
  document.getElementById('name').placeholder = `e.g. ${EXAMPLE_NAMES[Math.floor(Math.random() * EXAMPLE_NAMES.length)]}`;
  // Example room code under the code box, using the same letters real codes use.
  const EXAMPLE_CODE = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  document.getElementById('code').placeholder = EXAMPLE_CODE;
  document.querySelectorAll('[data-example-code]').forEach(el => { el.textContent = EXAMPLE_CODE; });
  const $ = (sel, root = document) => root.querySelector(sel);
  const landing = $('#landing'), app = $('#app'), toastEl = $('#toast'), announcer = $('#announcer');
  const STORE = 'flyway-session';
  const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWX', TARGETS = ['Heron', 'Avocet', 'Tern'];
  history.scrollRestoration = 'manual';

  let ws = null, state = null, offset = 0, retries = 0, retryTimer = null, leaving = false, silentJoin = false;
  let viewKey = null, lastSecond = null, toastTimer = null, tab = 'notebook', lastFeedId = null;
  let book = null, bookRound = null, draft = null, draftRound = null, ping = { col: '', row: '', species: '' };
  let saved = load();

  function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } }
  function persist() { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch {} }
  function forget() { saved = { name: saved.name }; persist(); }
  const now = () => Date.now() + offset;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const player = id => state?.players.find(p => p.id === id);
  const nameOf = id => player(id)?.name || 'An observer';
  const myId = () => saved.id;
  const isHost = () => state?.hostId === myId();
  const isLead = () => state?.leadId === myId();
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const bird = (species, cls = '') => `<svg class="bird ${cls}" aria-hidden="true"><use href="#b-${species}"/></svg>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---------- Sound ----------
  const sound = (() => {
    let ctx = null, on = localStorage.getItem('flyway-sound') !== 'off';
    const btn = $('#sound-toggle');
    const paint = () => { btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off'); btn.classList.toggle('muted', !on); };
    paint();
    btn.addEventListener('click', () => { on = !on; try { localStorage.setItem('flyway-sound', on ? 'on' : 'off'); } catch {} paint(); if (on) play('chirp'); });
    function audio() { if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); } if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    function tone(freq, start, dur, type = 'sine', gain = 0.08, to = null) {
      const a = audio(); if (!a) return;
      const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + start;
      o.type = type; o.frequency.setValueAtTime(freq, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
    }
    function play(name) {
      if (!on) return;
      try {
        if (name === 'chirp') { tone(2600, 0, 0.08, 'sine', 0.06, 3400); tone(2900, 0.1, 0.09, 'sine', 0.05, 3800); }
        if (name === 'tick') tone(1500, 0, 0.03, 'triangle', 0.03);
        if (name === 'pencil') tone(5000, 0, 0.03, 'square', 0.012);
        if (name === 'note') tone(740, 0, 0.1, 'triangle', 0.05);
        if (name === 'reveal') { [523, 659, 784].forEach((f, i) => tone(f, i * 0.1, 0.5, 'triangle', 0.06)); tone(2700, 0.35, 0.1, 'sine', 0.05, 3600); }
        if (name === 'perfect') { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.5, 'triangle', 0.06)); }
        if (name === 'reject') tone(220, 0, 0.18, 'sawtooth', 0.04, 150);
        if (name === 'badge') { tone(2400, 0, 0.09, 'sine', 0.06, 3300); tone(2800, 0.12, 0.09, 'sine', 0.05, 3900); [659, 880, 1175].forEach((f, i) => tone(f, 0.25 + i * 0.1, 0.5, 'triangle', 0.05)); }
        if (name === 'levelup') { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.1, 0.7, 'triangle', 0.06)); tone(3000, 0.6, 0.12, 'sine', 0.05, 4200); }
        if (name === 'pop') tone(2200, 0, 0.05, 'sine', 0.03, 2900);
      } catch {}
    }
    return { play };
  })();

  // ---------- Field rank, badges and the life list (fx.js) ----------
  const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const birdIcon = sp => `<svg viewBox="0 0 40 40" aria-hidden="true"><use href="#b-${sp}"/></svg>`;
  const FEATHER = 'M20 2C11 6 6 13 5 21l2 1c1-3 3-6 6-8-2 3-3 5-3 7 7-2 11-9 10-19z';
  FX.setup({
    key: 'flyway', sound: name => sound.play(name), cardTitle: 'FIELD RANK', levelKicker: 'NEW FIELD RANK', badgeKicker: 'FIELD BADGE', badgeShelf: 'FIELD BADGES',
    ranks: ['Novice Birder', 'Field Observer', 'Census Taker', 'Reed Warden', 'Estuary Warden', 'Ornithologist', 'Senior Ornithologist', 'Flyway Legend', 'Keeper of the Flyway'],
    statLabels: { games: 'Counts', rounds: 'Rounds', exact: 'Exact tallies', spoonbills: 'Spoonbills' },
    particles: [`<svg class="pt-feather" viewBox="0 0 24 24"><path d="${FEATHER}"/></svg>`, `<svg class="pt-feather rust" viewBox="0 0 24 24"><path d="${FEATHER}"/></svg>`, '<i class="pt-seed"></i>'],
    badges: {
      'first-count': { name: 'First Count', desc: 'File your first round.', icon: icon('M4 3h12l4 4v14H4zm3 6v2h10V9zm0 4v2h10v-2zm0 4v2h7v-2z'), xp: 20 },
      'sharp-eye': { name: 'Sharp Eye', desc: 'Tally your whole sector exactly.', icon: icon('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 4a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'), xp: 40 },
      detective: { name: 'Overlap Detective', desc: 'Get every overlap count right when birds sit in your strip.', icon: icon('M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z'), xp: 50 },
      spoonbill: { name: 'Spoonbill!', desc: 'File the rare bird’s exact cell.', icon: birdIcon('Spoonbill'), xp: 50 },
      perfect: { name: 'Perfect Count', desc: 'All three species exact in one round.', icon: icon('M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z'), xp: 60 },
      decoy: { name: 'Decoy Dodger', desc: 'Exact heron and avocet totals in a round with decoys.', icon: birdIcon('Egret'), xp: 50 },
      'life-list': { name: 'Full Life List', desc: 'Spot all six species in your own sector.', icon: icon(FEATHER), xp: 100 },
      ornithologists: { name: 'Ornithologists', desc: 'Finish a count with the top rank title.', icon: icon('M12 2l2.5 5 5.5.8-4 3.9.9 5.5L12 14.6 7.1 17.2l.9-5.5-4-3.9L9.5 7z'), xp: 120 },
    },
  });
  const SPECIES = ['Heron', 'Avocet', 'Tern', 'Egret', 'Dunlin', 'Spoonbill'];
  const ROUND_NAMES = ['', 'FIRST LIGHT', 'THE SPOONBILL STIRS', 'DECOYS IN THE REEDS', 'CROWDED STRIPS', 'THE GREAT FLOCK'];
  const ROUND_SUBS = ['', 'A gentle start. No decoys, no rare bird.', 'Somewhere out there: one spoonbill.', 'Egrets and dunlins are not on the list.', 'More birds sit in the shared strips.', 'The densest scene of the dawn.'];
  function lifeList() { const p = FX.profile(); p.life ||= {}; return p.life; }
  // Like a birder's life list: every species you've seen in your own sector, with a sighting count.
  function logSightings() {
    const key = `${state.code}:${state.round}:sight`;
    if (!state.mine || processed.has(key)) return;
    processed.add(key);
    const life = lifeList(), seen = new Set(state.mine.map(b => b.species));
    for (const sp of seen) {
      const first = !life[sp];
      life[sp] = (life[sp] || 0) + 1;
      if (first) setTimeout(() => FX.toast(`<div class="fx-medal">${birdIcon(sp)}</div><div class="fx-badge-text"><small>NEW FOR YOUR LIFE LIST</small><b>${sp}</b><span>${sp === 'Spoonbill' ? 'The rare one. Note its cell.' : ['Egret', 'Dunlin'].includes(sp) ? 'A decoy. Don\u2019t count it.' : 'Added to your field guide.'}</span></div>`, 'fx-badge', 3800), 1800);
    }
    if (seen.has('Spoonbill')) FX.bump('spoonbills');
    if (SPECIES.every(sp => life[sp])) FX.unlock('life-list');
    FX.bump('sightings');
  }
  function renderLife(target) {
    if (!target) return;
    const life = lifeList();
    target.innerHTML = `<div class="life-head"><small>MY LIFE LIST</small><b>${SPECIES.filter(sp => life[sp]).length} of ${SPECIES.length}</b></div>
      <div class="life-grid">${SPECIES.map(sp => `<figure class="${life[sp] ? 'seen' : ''} ${sp === 'Spoonbill' ? 'rare' : ''}"><svg><use href="#b-${sp}"/></svg><figcaption>${life[sp] ? sp : '???'}</figcaption><span>${life[sp] ? `×${life[sp]}` : 'unseen'}</span></figure>`).join('')}</div>`;
  }
  let processed = new Set(), gameXP = 0, exactStreak = 0;
  function processRound() {
    const rv = state.reveal, r = rv?.result, key = `${state.code}:${state.round}:${r?.points}`;
    if (!r || processed.has(key)) return;
    processed.add(key);
    const mine = r.observers.find(o => o.id === myId());
    let xp = 15 + Math.round(r.points / 10);
    FX.bump('rounds'); FX.unlock('first-count');
    for (const sp of TARGETS) { if (r.species[sp].error === 0) { exactStreak++; FX.bump('exact'); } else exactStreak = 0; }
    if (mine) {
      if (mine.sectorError === 0 && TARGETS.some(sp => mine.truth[sp])) { xp += 20; FX.unlock('sharp-eye'); }
      const myStrip = rv.birds.filter(b => b.shared && !b.decoy && !b.rare && inSector(b, sector()));
      if (mine.overlapError === 0 && myStrip.length) { xp += 15; FX.unlock('detective'); }
    }
    if (r.rare?.right) FX.unlock('spoonbill');
    if (r.perfect) FX.unlock('perfect');
    if (r.decoys.length && r.species.Heron.error === 0 && r.species.Avocet.error === 0) FX.unlock('decoy');
    gameXP += xp;
    setTimeout(() => FX.addXP(xp, app.querySelector('.srow.total')), 2600);
  }
  function inSector(b, s) { return s && b.x >= s.x0 && b.x <= s.x1 && b.y >= s.y0 && b.y <= s.y1; }
  function finishCount() {
    const key = `${state.code}:final:${state.teamScore}`;
    if (processed.has(key)) return;
    processed.add(key);
    FX.recordGame((state.awards?.title || '') !== 'Apprentices');
    setTimeout(() => {
      FX.addXP(40, app.querySelector('.total'));
      if (state.awards?.title === 'Ornithologists') FX.unlock('ornithologists');
      const box = app.querySelector('[data-r="count-xp"]'); if (box) box.textContent = `+${gameXP + 40} XP this count`;
    }, 1400);
  }
  function shareText() {
    const lines = state.results.map(r => `R${r.round} ${TARGETS.map(sp => (r.species[sp].error ? '🟥' : '🟩')).join('')}${r.rare ? (r.rare.right ? ' 🥄' : ' ·') : ''}`);
    return `Flyway: The Great Count · ${state.code}\n${lines.join('\n')}\n${state.teamScore} points · ${state.awards?.title || ''} of the estuary\nField rank: ${FX.level().name}`;
  }

  function toast(text, kind = '') { toastEl.textContent = text; toastEl.className = `toast show ${kind}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600); }
  function announce(text) { announcer.textContent = ''; setTimeout(() => { announcer.textContent = text; }, 30); }

  // ---------- Connection ----------
  function connect(hello) {
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= 1) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
    ws.onopen = () => { retries = 0; document.body.classList.remove('offline'); ws.send(JSON.stringify(hello)); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      if (leaving) return;
      if (!state) { if (!silentJoin) showError('The count cannot be reached. Check your connection.'); silentJoin = false; return; }
      document.body.classList.add('offline');
      retryTimer = setTimeout(() => connect({ type: 'join', code: saved.code, token: saved.token, name: saved.name }), Math.min(8000, 600 * 2 ** retries++));
    };
  }
  function send(type, data = {}) { if (ws?.readyState === 1) { ws.send(JSON.stringify({ type, ...data })); return true; } toast('Still reconnecting. Hold tight.'); return false; }
  function onMessage(m) {
    if (m.type === 'joined') {
      Object.assign(saved, { code: m.code, token: m.token, id: m.id }); persist(); silentJoin = false;
      const url = new URL(location.href); url.searchParams.set('count', m.code); history.replaceState(null, '', url);
    }
    if (m.type === 'state') { offset = m.state.serverNow - Date.now(); const prev = state; state = m.state; render(prev); }
    if (m.type === 'reject') { toast(m.message, 'bad'); sound.play('reject'); }
    if (m.type === 'error') {
      if (m.code === 'no-room') { forget(); state = null; viewKey = null; showLanding(); if (!silentJoin) showError(m.message); silentJoin = false; return; }
      if (m.code === 'replaced') { leaving = true; state = null; showLanding(); showError(m.message); return; }
      if (!state) showError(m.message); else toast(m.message, 'bad');
    }
  }

  // ---------- Landing ----------
  const nameInput = $('#name'), codeInput = $('#code');
  nameInput.value = saved.name || '';
  const urlCode = (new URLSearchParams(location.search).get('count') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  codeInput.value = urlCode;
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  function showError(t) { $('#error').textContent = t; }
  function readName() {
    const name = nameInput.value.trim();
    if (name.length < 2) { showError('Use a name between 2 and 14 characters.'); nameInput.focus(); return null; }
    saved.name = name; persist(); showError(''); leaving = false; return name;
  }
  $('#landing-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = readName(); if (!name) return;
    if (codeInput.value.length !== 4) { showError('Count codes are four letters.'); codeInput.focus(); return; }
    connect({ type: 'join', code: codeInput.value, name, token: saved.code === codeInput.value ? saved.token : undefined });
  });
  $('#host').addEventListener('click', () => { const n = readName(); if (n) { forget(); saved.name = n; connect({ type: 'create', name: n }); } });
  $('#practice').addEventListener('click', () => { const n = readName(); if (n) { forget(); saved.name = n; connect({ type: 'practice', name: n }); } });
  function showLanding() {
    FX.card($('#rankcard')); renderLife($('#lifelist'));
    app.classList.add('hidden'); landing.classList.remove('hidden'); document.body.dataset.phase = 'landing';
    const url = new URL(location.href); url.searchParams.delete('count'); history.replaceState(null, '', url); codeInput.value = '';
  }

  FX.card($('#rankcard')); renderLife($('#lifelist'));

  // ---------- Tutorial ----------
  const tut = $('#tutorial'), slides = [...tut.querySelectorAll('.slide')], dots = [...tut.querySelectorAll('.dots i')];
  let slide = 0;
  function showSlide(i) { slide = i; slides.forEach((s, n) => s.classList.toggle('active', n === i)); dots.forEach((d, n) => d.classList.toggle('on', n === i)); $('#tut-step').textContent = `${i + 1} OF ${slides.length}`; $('#tut-next').textContent = i === slides.length - 1 ? 'INTO THE FIELD' : 'NEXT →'; }
  function openTut() { showSlide(0); tut.showModal(); }
  $('#help-open').addEventListener('click', openTut);
  $('#tut-close').addEventListener('click', () => tut.close());
  $('#tut-skip').addEventListener('click', () => tut.close());
  $('#tut-next').addEventListener('click', () => slide < slides.length - 1 ? showSlide(slide + 1) : tut.close());
  tut.addEventListener('close', () => { try { localStorage.setItem('flyway-tutorial', '1'); } catch {} });
  if (!localStorage.getItem('flyway-tutorial')) setTimeout(openTut, 600);

  // ---------- Render ----------
  function render(prev) {
    landing.classList.add('hidden'); app.classList.remove('hidden');
    document.body.dataset.phase = state.phase;
    // Local notebook and draft copies keep steppers instant; they reset each round.
    if (state.notebook && bookRound !== state.round) { book = JSON.parse(JSON.stringify(state.notebook)); bookRound = state.round; }
    if (state.draft && (draftRound !== state.round || !isLead())) { draft = JSON.parse(JSON.stringify(state.draft)); draftRound = state.round; }
    const screen = SCREENS[state.phase]();
    const regions = { head: headRegion() + coachBar(), ...screen.regions };
    if (screen.key !== viewKey) { viewKey = screen.key; app.innerHTML = screen.shell; window.scrollTo(0, 0); }
    for (const [name, html] of Object.entries(regions)) {
      const el = app.querySelector(`[data-r="${name}"]`);
      if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; if (name === 'feed') el.scrollTop = el.scrollHeight; }
    }
    FX.paintChips();
    cues(prev);
    tick();
  }
  function cues(prev) {
    const last = state.feed.at(-1);
    if (prev && last && last.id !== lastFeedId && last.kind === 'chip') sound.play('note');
    lastFeedId = last?.id;
    if (!prev || prev.phase === state.phase) { if (prev && prev.leadId !== state.leadId && isLead()) toast('You are now the Lead Counter.'); return; }
    const p = state.phase;
    if (p === 'scout') {
      sound.play('chirp'); announce(`Round ${state.round} of 5. Scout your sector.`);
      if (state.round === 1) { gameXP = 0; exactStreak = 0; }
      FX.splash({ kicker: `ROUND ${state.round} OF 5`, title: ROUND_NAMES[state.round] || 'DAWN', sub: ROUND_SUBS[state.round] || '', ms: 1900 });
      logSightings();
    }
    if (p === 'lockin') { sound.play('note'); announce(isLead() ? 'Lock-in. You are the Lead Counter: file the count.' : 'Lock-in. The Lead Counter is filing the count.'); }
    if (p === 'reveal') {
      const r = state.reveal?.result; sound.play(r?.perfect ? 'perfect' : 'reveal'); announce(`The marsh revealed. ${r?.points ?? 0} points this round.`);
      // Birds land one at a time across the whole marsh, then the points tick up.
      const birds = app.querySelectorAll('.marsh.full .c.has');
      birds.forEach((c, i) => setTimeout(() => sound.play('pop'), 200 + i * 55));
      const total = app.querySelector('.srow.total strong'); if (total) setTimeout(() => FX.countUp(total, r?.points || 0, { ms: 900 }), 200 + birds.length * 55);
      if (r?.perfect || r?.rare?.right) setTimeout(() => FX.burst(app.querySelector(r.perfect ? '.srow.total' : '.c.rare'), { count: 34 }), 400 + birds.length * 55);
      processRound();
    }
    if (p === 'final') finishCount();
  }

  const SCREENS = {
    lobby() {
      return { key: 'lobby', shell: `<div data-r="head"></div><section class="sheet lobby"><div class="eyebrow">FIELD ROSTER</div><h2>Choose your watchposts</h2><div data-r="roster"></div><div data-r="start"></div></section>`,
        regions: { roster: rosterHtml(), start: startHtml() } };
    },
    scout() {
      const me = player(myId());
      if (!me?.observing) return spectatorScreen('SCOUT');
      return {
        key: `scout:${state.round}`,
        shell: `<div data-r="head"></div>
          <div data-r="title"></div>
          <div class="field">
            <div class="post-col"><div data-r="postmeta"></div><div class="binocular">${gridHtml(sector(), state.mine, false)}</div>${legendHtml()}${srBirds()}</div>
            <div class="desk">
              <div class="tabs" role="tablist">${[['notebook', 'NOTEBOOK'], ['sheet', 'TEAM SHEET'], ['feed', 'FIELD SIGNALS']].map(([k, l]) => `<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
              <div class="panels tab-${tab}">
                <section class="card notebook" data-r="notebook"></section>
                <section class="card sheet-card" data-r="sheet"></section>
                <section class="card signals"><div data-r="pingform"></div><div class="feed" data-r="feed"></div></section>
              </div>
            </div>
          </div>`,
        regions: { title: titleBar('SCOUT', 'Observe your patch'), postmeta: postMeta(), notebook: notebookHtml(), sheet: sheetHtml(), pingform: pingForm(), feed: feedHtml() },
      };
    },
    lockin() {
      const me = player(myId());
      return {
        key: `lockin:${state.round}:${isLead()}`,
        shell: `<div data-r="head"></div><div data-r="title"></div>
          <div class="lock-grid">
            <section class="card report" data-r="report"></section>
            <div class="lock-side"><section class="card sheet-card" data-r="sheet"></section><section class="card signals">${me?.observing && !isLead() ? '<div class="chips"><button data-action="back" class="btn estuary">👍 BACK THE LEAD</button><button data-action="chip" data-chip="hold">HOLD ON</button><button data-action="chip" data-chip="overlap">CHECK OVERLAP</button></div>' : '<div class="chips"><button data-action="chip" data-chip="agreed">AGREED</button><button data-action="chip" data-chip="hold">HOLD ON</button></div>'}<div class="feed" data-r="feed"></div></section></div>
          </div>`,
        regions: { title: titleBar('LOCK-IN', isLead() ? 'File the count' : 'The Lead files the count'), report: reportHtml(), sheet: sheetHtml(), feed: feedHtml() },
      };
    },
    reveal() {
      return { key: `reveal:${state.round}`, shell: `<div data-r="head"></div><div data-r="title"></div><section data-r="body"></section>`,
        regions: { title: titleBar('REVEAL', 'The marsh, seen whole'), body: revealHtml() } };
    },
    scores() {
      return { key: `scores:${state.round}`, shell: `<div data-r="head"></div><section data-r="body"></section>`, regions: { body: scoresHtml() } };
    },
    final() { return { key: 'final', shell: `<div data-r="head"></div><section data-r="body"></section>`, regions: { body: finalHtml() } }; },
  };
  function spectatorScreen(label) {
    return { key: `spect:${state.phase}:${state.round}`, shell: `<div data-r="head"></div><div data-r="title"></div><section class="card sheet-card" data-r="sheet"></section><section class="card signals"><div class="feed" data-r="feed"></div></section>`,
      regions: { title: titleBar(label, 'Watching from the hide'), sheet: sheetHtml(), feed: feedHtml() } };
  }

  // ---------- Pieces ----------
  function coachBar() {
    const c = coach(); if (!c) return '';
    return `<div class="coach" role="note"><span class="coach-tag">YOUR MOVE</span><div class="coach-text"><b>${c[0]}</b>${c[1] ? `<span>${c[1]}</span>` : ''}</div></div>`;
  }
  function coach() {
    const p = state.phase, host = isHost(), observing = player(myId())?.observing;
    if (p === 'lobby') return host ? ['Press OPEN THE MARSH when 2 or more observers are here.', 'Each of you gets a different piece of the marsh to watch.'] : ['Wait for the host to open the marsh.', 'You\u2019ll get your own piece of the marsh to watch.'];
    if (!observing && p !== 'final') return ['You\u2019re watching this round.', 'You\u2019ll get your own patch of marsh next round.'];
    if (p === 'scout') return ['Count the herons, avocets and terns in your patch.', `Enter them under SEEN. Then count how many of those sit in the striped strip and enter them under IN OVERLAP: your neighbour sees those birds too.${state.round >= 3 ? ' Egrets and dunlins are decoys, so skip them.' : ''}${state.round >= 2 ? ' Spot the rare spoonbill? Note its cell (like K4).' : ''} Tap I\u2019M DONE when finished.`];
    if (p === 'lockin') return isLead()
      ? ['You\u2019re the Lead: file the true totals.', 'For each bird: add up everyone\u2019s SEEN, then subtract half of everyone\u2019s OVERLAP (those birds were counted twice). Set the numbers, add the spoonbill cell, and press FILE.']
      : [`Help ${esc(nameOf(state.leadId))} file the count.`, 'Check the Team Sheet. Spot a mistake? Say so. Happy? Tap BACK THE LEAD.'];
    if (p === 'reveal') return ['The whole marsh, revealed.', 'Circled birds were in two notebooks, so they count once. Each species scores 100, minus 25 for every bird you were off.'];
    if (p === 'scores') return ['Round filed.', 'The next round starts by itself, with a new marsh and more birds.'];
    if (p === 'final') return ['The count is complete.', host ? 'Press COUNT AGAIN for five new marshes.' : 'Share your result, or wait for the host.'];
    return null;
  }
  function headRegion() {
    const me = player(myId());
    const live = !['lobby', 'final'].includes(state.phase);
    return `<div class="roomhead">
      <div class="code"><small>COUNT</small><b>${esc(state.code)}</b><button class="link-btn" data-action="invite">invite</button></div>
      <div class="roomhead-mid">${live ? `<span class="pill">ROUND ${state.round} OF 5</span><span class="pill">TEAM ${state.teamScore}</span>` : ''}${live && exactStreak >= 2 ? `<span class="streak ${exactStreak >= 5 ? 'hot' : ''}" title="Exact species totals in a row">EXACT <b>×${exactStreak}</b></span>` : ''}${state.practice ? '<span class="pill">PRACTICE</span>' : ''}</div>
      <div class="roomhead-right">${isHost() ? '<span class="hostmark">HOST</span>' : ''}<button class="link-btn" data-action="leave">leave</button></div>
    </div>
    ${live && !me?.observing ? '<div class="banner">You joined mid-count. Study the Team Sheet; you get a watchpost next round.</div>' : ''}
    ${state.paused ? `<div class="banner warn">Too few observers in the field. The count is paused while they reconnect.${isHost() ? ' <button class="link-btn" data-action="resume">back to the roster</button>' : ''}</div>` : ''}`;
  }
  function titleBar(label, title) {
    const lead = state.leadId && ['scout', 'lockin'].includes(state.phase) ? `<span class="leadtag ${isLead() ? 'me' : ''}">${isLead() ? 'YOU ARE LEAD COUNTER' : `LEAD · ${esc(nameOf(state.leadId))}`}</span>` : '';
    const timed = state.endsAt && state.phase !== 'final';
    return `<div class="phasebar"><div><div class="eyebrow">ROUND ${state.round} OF 5 · ${label}</div><h2>${title}</h2>${lead}</div>${timed ? '<div class="timer" data-clock aria-hidden="true"><svg viewBox="0 0 100 100"><circle class="face" cx="50" cy="50" r="44"/><circle class="ring" cx="50" cy="50" r="44" pathLength="100"/></svg><b data-secs>--</b></div>' : ''}</div>`;
  }
  function sector(id = myId()) { return state.sectors.find(s => s.playerId === id); }
  function sharedCols(s) {
    // A cell is in my overlap strip if another sector also covers it.
    return (x, y) => state.sectors.some(o => o !== s && x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1);
  }
  function gridHtml(range, birds, full) {
    if (!range) return '';
    const byCell = new Map((birds || []).map(b => [b.cell, b]));
    const mineS = sector();
    const shared = full ? (x, y) => state.sectors.filter(o => x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1).length >= 2 : sharedCols(mineS);
    const cols = range.x1 - range.x0 + 1;
    let landed = 0;
    let html = `<div class="marsh ${full ? 'full' : ''}" style="--cols:${cols}" role="grid" aria-label="${full ? 'The whole marsh' : 'Your watchpost'}"><div class="mrow head"><span></span>${Array.from({ length: cols }, (_, i) => `<b>${COLS[range.x0 + i]}</b>`).join('')}</div>`;
    for (let y = range.y0; y <= range.y1; y++) {
      html += `<div class="mrow"><span class="rn">${y + 1}</span>`;
      for (let x = range.x0; x <= range.x1; x++) {
        const cell = COLS[x] + (y + 1), b = byCell.get(cell), over = shared(x, y);
        const res = state.reveal?.result;
        const flags = full && b ? [b.shared && !b.decoy && !b.rare ? 'twice' : '', b.decoy ? 'decoy' : '', b.rare ? 'rare' : ''].join(' ') : '';
        const wrongPin = full && res?.rare && res.rare.said === cell && !res.rare.right;
        html += `<div class="c ${over ? 'over' : ''} ${b ? 'has ' + b.species.toLowerCase() : ''} ${flags} ${wrongPin ? 'pin' : ''}" ${full && b ? `style="--d:${(0.2 + landed++ * 0.055).toFixed(3)}s"` : ''} title="${cell}${b ? ' · ' + b.species : ''}">${b ? bird(b.species) : ''}${b && full && b.rare ? '<i class="ring"></i>' : ''}</div>`;
      }
      html += '</div>';
    }
    return html + '</div>';
  }
  function legendHtml() {
    const r = state.round;
    return `<div class="legend">${TARGETS.map(s => `<span>${bird(s)}${s}</span>`).join('')}${r >= 3 ? `<span class="decoy">${bird('Egret')}Egret <i>decoy</i></span><span class="decoy">${bird('Dunlin')}Dunlin <i>decoy</i></span>` : ''}${r >= 2 ? `<span class="rare">${bird('Spoonbill')}Spoonbill <i>rare</i></span>` : ''}<span class="hatchkey"><i></i>shared strip</span></div>`;
  }
  function srBirds() {
    const list = state.mine || [];
    return `<p class="sr-only">Birds in your sector: ${list.length ? list.map(b => `${b.species} at ${b.cell}`).join(', ') : 'none'}.</p>`;
  }
  function postMeta() {
    const s = sector(); if (!s) return '';
    const neighbors = state.sectors.filter(o => o !== s && o.x0 <= s.x1 && o.x1 >= s.x0 && o.y0 <= s.y1 && o.y1 >= s.y0);
    return `<div class="postmeta"><b>WATCHPOST ${s.post}</b><span>cols ${COLS[s.x0]}–${COLS[s.x1]} · rows ${s.y0 + 1}–${s.y1 + 1}</span><span class="hatchnote">hatched cells are shared with ${neighbors.map(n => esc(nameOf(n.playerId))).join(' & ') || 'no one'}</span></div>
      ${state.round === 1 ? '<p class="coach">Coach tip: a bird in the hatched strip is also in your neighbour’s notebook. Count it, then tally it again under “in overlap” so the Lead can subtract it once.</p>' : ''}`;
  }
  function tallyMarks(n) {
    let out = '';
    for (let i = 0; i < Math.floor(n / 5); i++) out += '<span class="tg five"><i></i><i></i><i></i><i></i><s></s></span>';
    if (n % 5) out += `<span class="tg">${'<i></i>'.repeat(n % 5)}</span>`;
    return `<span class="tally" aria-hidden="true">${out}</span>`;
  }
  function notebookHtml() {
    const b = book || state.notebook; if (!b) return '';
    const step = (sp, key, d) => `<button class="step" data-action="step" data-sp="${sp}" data-key="${key}" data-d="${d}" aria-label="${d > 0 ? 'Add' : 'Remove'} one ${sp}${key === 'overlaps' ? ' in overlap' : ''}">${d > 0 ? '+' : '−'}</button>`;
    return `<div class="card-head"><span>FIELD NOTEBOOK</span>${state.notebook?.shared ? '<i class="tag t-water">LIVE ON SHEET</i>' : '<i class="tag">PRIVATE</i>'}</div>
      ${TARGETS.map(sp => `<div class="trow">
        <div class="tname">${bird(sp)}<b>${sp}</b></div>
        <div class="tcount"><small>SEEN</small><div class="stepper">${step(sp, 'tallies', -1)}<output>${b.tallies[sp]}</output>${step(sp, 'tallies', 1)}</div>${tallyMarks(b.tallies[sp])}</div>
        <div class="tcount over"><small>IN OVERLAP</small><div class="stepper">${step(sp, 'overlaps', -1)}<output>${b.overlaps[sp]}</output>${step(sp, 'overlaps', 1)}</div></div>
      </div>`).join('')}
      ${state.notebook?.shared ? '<p class="hint">Shared. Changes update the Team Sheet as you make them.</p>' : '<button class="btn estuary full" data-action="share">SHARE TO TEAM SHEET →</button>'}
      ${doneRow()}`;
  }
  function doneRow() {
    const people = state.players.filter(p => p.observing && !p.isBot && p.connected), n = people.filter(p => state.done.includes(p.id)).length, mine = state.done.includes(myId());
    return `<div class="done-row"><button class="btn ${mine ? 'paper' : 'rust'} full" data-action="done">${mine ? 'WAIT, STILL LOOKING' : 'I’M DONE SCOUTING →'}</button><span class="hint">${n} of ${people.length} done · lock-in starts early when everyone is${state.practice ? '' : ''}</span></div>`;
  }
  function sheetHtml() {
    const rows = [...state.sheet].sort((a, b) => (sector(a.id)?.post || 0) - (sector(b.id)?.post || 0));
    const sum = (k, sp) => rows.reduce((n, r) => n + r[k][sp], 0);
    const observers = state.players.filter(p => p.observing).length;
    return `<div class="card-head"><span>TEAM SHEET</span><span class="muted">${rows.length} of ${observers} shared · raw, not de-duplicated</span></div>
      ${rows.length ? `<div class="tablewrap"><table class="sheet-table"><thead><tr><th>Post</th>${TARGETS.map(sp => `<th>${bird(sp)}${sp}<small>seen (overlap)</small></th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => { const s = sector(r.id); return `<tr class="${r.id === myId() ? 'mine' : ''}"><td><b>${s?.post ?? '–'}</b> ${esc(r.name)}${r.isBot ? ' <i class="tag">BOT</i>' : ''}<small>${s ? `${COLS[s.x0]}–${COLS[s.x1]}${state.sectors.length > 4 ? ` · ${s.y0 === 0 ? 'north' : 'south'}` : ''}` : ''}</small></td>${TARGETS.map(sp => `<td>${r.tallies[sp]} <em>(${r.overlaps[sp]})</em></td>`).join('')}</tr>`; }).join('')}</tbody>
      <tfoot><tr><td>Raw total</td>${TARGETS.map(sp => `<td>${sum('tallies', sp)} <em>(${sum('overlaps', sp)})</em></td>`).join('')}</tr></tfoot></table></div>
      <p class="hint">Every shared bird sits in two notebooks. Neighbours' overlap counts should match; if they don't, someone should look again.</p>` : '<p class="hint">No notebooks shared yet.</p>'}`;
  }
  function pingForm() {
    const colOpts = `<option value="">col</option>${[...COLS].map(c => `<option ${ping.col === c ? 'selected' : ''}>${c}</option>`).join('')}`;
    const rowOpts = `<option value="">row</option>${Array.from({ length: 8 }, (_, i) => `<option ${ping.row === String(i + 1) ? 'selected' : ''}>${i + 1}</option>`).join('')}`;
    const spOpts = `<option value="">bird</option>${['Heron', 'Avocet', 'Tern', 'Egret', 'Dunlin', 'Spoonbill'].map(s => `<option ${ping.species === s ? 'selected' : ''}>${s}</option>`).join('')}`;
    return `<div class="card-head"><span>FIELD SIGNALS</span><span class="muted">presets only</span></div>
      <div class="chips"><button data-action="chip" data-chip="overlap">CHECK YOUR OVERLAP</button><button data-action="chip" data-chip="rare">RARE BIRD?</button><button data-action="chip" data-chip="agreed">AGREED</button><button data-action="chip" data-chip="hold">HOLD ON</button></div>
      <div class="cellping"><span>I see</span><select data-ping="species" aria-label="Bird">${spOpts}</select><span>at</span><select data-ping="col" aria-label="Column">${colOpts}</select><select data-ping="row" aria-label="Row">${rowOpts}</select><button class="btn estuary" data-action="cell">SEND</button></div>`;
  }
  function feedHtml() {
    if (!state.feed.length) return '<p class="hint pad">Quiet now. Something rare is out there.</p>';
    return state.feed.map(f => `<p class="f-${f.kind}">${f.from ? `<b>${esc(f.from)}</b> ` : ''}${esc(f.text)}</p>`).join('');
  }
  function reportHtml() {
    const d = isLead() ? draft : state.draft; if (!d) return '';
    const lead = isLead();
    const step = (sp, delta) => `<button class="step big" data-action="dstep" data-sp="${sp}" data-d="${delta}" aria-label="${delta > 0 ? 'Add one' : 'Remove one'} ${sp}">${delta > 0 ? '+' : '−'}</button>`;
    const [col, row] = d.rareCell ? [d.rareCell[0], d.rareCell.slice(1)] : ['', ''];
    const raw = sp => state.sheet.reduce((n, r) => n + r.tallies[sp], 0), ovl = sp => state.sheet.reduce((n, r) => n + r.overlaps[sp], 0);
    return `<div class="card-head"><span>${lead ? 'YOUR REPORT' : `${esc(nameOf(state.leadId))}'S REPORT · LIVE`}</span>${state.backers.length ? `<span class="muted">👍 ${state.backers.map(id => esc(nameOf(id))).join(', ')}</span>` : ''}</div>
      ${TARGETS.map(sp => `<div class="rrow"><div class="tname">${bird(sp)}<b>${sp}</b></div>${lead ? `<div class="stepper">${step(sp, -1)}<output>${d.totals[sp]}</output>${step(sp, 1)}</div>` : `<output class="ro">${d.totals[sp]}</output>`}<small class="calc">sheet: ${raw(sp)} seen, ${ovl(sp)} overlap tallies</small></div>`).join('')}
      ${state.round >= 2 ? `<div class="rrow rare"><div class="tname">${bird('Spoonbill')}<b>Spoonbill cell</b></div>${lead ? `<div class="cellpick"><select data-rare="col" aria-label="Spoonbill column"><option value="">–</option>${[...COLS].map(c => `<option ${c === col ? 'selected' : ''}>${c}</option>`).join('')}</select><select data-rare="row" aria-label="Spoonbill row"><option value="">–</option>${Array.from({ length: 8 }, (_, i) => `<option ${String(i + 1) === row ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>` : `<output class="ro">${d.rareCell || 'not found'}</output>`}</div>` : '<p class="hint">No rare bird in round one.</p>'}
      ${lead ? '<button class="btn rust full" data-action="file">FILE THE REPORT →</button><p class="hint">If the timer runs out, these numbers are filed as they stand.</p>' : '<p class="hint">Watch the numbers change as the Lead works. Speak up, or back them.</p>'}`;
  }
  function revealHtml() {
    const rv = state.reveal; if (!rv) return '';
    const r = rv.result;
    const callouts = TARGETS.map(sp => {
      const s = r.species[sp], extra = s.raw - s.truth;
      if (!s.sharedCells.length) return null;
      return `${plural(s.sharedCells.length, sp.toLowerCase())} sat in shared strips (${s.sharedCells.join(', ')})${s.raw ? `; the notebooks summed to ${s.raw}, ${extra > 0 ? `${extra} over the true ${s.truth}` : extra < 0 ? `${-extra} under the true ${s.truth}` : 'exactly the true count'}` : ''}.`;
    }).filter(Boolean);
    const decoys = r.decoys.length ? `${r.decoys.map(d => `${d.species.toLowerCase()} at ${d.cell}`).join(', ')} ${r.decoys.length === 1 ? 'was a decoy' : 'were decoys'}: not counted.` : null;
    return `<div class="reveal-wrap">
      <div class="card marsh-card">${gridHtml({ x0: 0, x1: 23, y0: 0, y1: 7 }, rv.birds, true)}
        <div class="legend"><span class="k twice"><i></i>seen by two observers</span><span class="k decoy"><i></i>decoy</span><span class="k rare"><i></i>spoonbill</span>${r.rare && !r.rare.right && r.rare.said ? '<span class="k pin"><i></i>your guess</span>' : ''}<span class="hatchkey"><i></i>shared strip</span></div>
      </div>
      <div class="card scorecard">
        <div class="card-head"><span>ROUND ${state.round} · FILED BY ${esc(r.leadName)}</span>${r.filed ? '' : '<span class="muted">timer filed it</span>'}</div>
        ${TARGETS.map(sp => { const s = r.species[sp]; return `<div class="srow ${s.error ? '' : 'exact'}"><div class="tname">${bird(sp)}<b>${sp}</b></div><span>${s.truth} true · you said ${s.said}</span><strong>+${s.points}</strong></div>`; }).join('')}
        ${r.rare ? `<div class="srow ${r.rare.right ? 'exact' : ''}"><div class="tname">${bird('Spoonbill')}<b>Spoonbill</b></div><span>at ${r.rare.cell} · you said ${r.rare.said || 'nothing'}</span><strong>${r.rare.right ? '+100' : '+0'}</strong></div>` : ''}
        ${r.perfect ? '<div class="srow exact perfect"><div class="tname"><b>Perfect round</b></div><span>all three totals exact</span><strong>+100</strong></div>' : ''}
        <div class="srow total"><b>Round total</b><strong>${r.points}</strong></div>
        <ul class="callouts">${callouts.map(c => `<li>${c}</li>`).join('')}${decoys ? `<li>${decoys}</li>` : ''}</ul>
      </div>
      <div class="card accuracy"><div class="card-head"><span>NOTEBOOK ACCURACY</span><span class="muted">against each sector's truth</span></div>
        <table class="sheet-table"><thead><tr><th>Observer</th><th>Tally misses</th><th>Overlap misses</th></tr></thead><tbody>${r.observers.map(o => `<tr class="${o.id === myId() ? 'mine' : ''}"><td>${esc(o.name)}${o.isBot ? ' <i class="tag">BOT</i>' : ''}${o.shared ? '' : ' <small>not shared</small>'}</td><td>${o.sectorError || '✓'}</td><td>${o.overlapError || '✓'}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  }
  function roundBars() {
    const max = 500;
    return `<div class="bars" aria-label="Points per round">${Array.from({ length: 5 }, (_, i) => { const r = state.results[i]; return `<div class="bar"><span style="height:${r ? Math.max(4, r.points / max * 100) : 0}%">${r ? `<b>${r.points}</b>` : ''}</span><small>R${i + 1}</small></div>`; }).join('')}</div>`;
  }
  function scoresHtml() {
    const r = state.results.at(-1);
    return `<div class="card result"><div class="eyebrow">ROUND ${state.round} FILED</div><h2>${r?.perfect ? 'A perfect count.' : r?.points >= 300 ? 'Good, careful work.' : 'The marsh is tricky.'}</h2>
      <div class="total">${state.teamScore}<small>TEAM POINTS</small></div>${roundBars()}
      <p class="hint">Next watch begins in <span data-secs>--</span>s. ${state.round < 5 ? `Round ${state.round + 1}: ${['', '', 'the spoonbill appears', 'decoys arrive', 'more birds sit in the overlaps', 'the densest scene'][state.round + 1] || ''}.` : ''}</p></div>`;
  }
  function finalHtml() {
    const a = state.awards || {};
    const card = (title, x, blurb) => `<div class="award"><small>${title}</small><b>${x ? esc(x.name) : '—'}</b><span>${x ? esc(x.detail) : blurb}</span></div>`;
    return `<div class="card result final"><div class="eyebrow">THE GREAT COUNT · COMPLETE</div><h2>${esc(a.title || 'Observers')} of the estuary</h2>
      <div class="total">${state.teamScore}<small>TEAM POINTS OF 2,400</small></div>${roundBars()}
      <div class="awards">${card('SHARP EYE', a.sharp, 'most accurate tallies')}${card('OVERLAP DETECTIVE', a.detective, 'most accurate overlaps')}${card('STEADY LEAD', a.steady, 'best round as Lead')}</div>
      <p class="hint">Five rounds. One marsh. A team that learned to see together.</p>
      <div class="count-card"><div><small>YOUR COUNT</small><b data-r="count-xp">Writing up your field notes…</b></div><span data-fx-chip></span><button class="btn paper" data-action="share">SHARE RESULT</button></div>
      ${isHost() ? '<button class="btn rust full" data-action="again">COUNT AGAIN ↻</button>' : '<p class="hint">Waiting for the host to start another count.</p>'}</div>`;
  }
  function rosterHtml() {
    return `<ul class="roster">${state.players.map((p, i) => `<li class="${p.connected ? '' : 'away'}"><span class="postno">${i + 1}</span><span class="r-name">${esc(p.name)}</span>${p.id === state.hostId ? '<i class="tag t-rust">HOST</i>' : ''}${p.id === myId() ? '<i class="tag">YOU</i>' : ''}${p.isBot ? '<i class="tag">BOT</i>' : ''}${!p.connected ? '<i class="tag">AWAY</i>' : ''}</li>`).join('')}</ul>`;
  }
  function startHtml() {
    const n = state.players.filter(p => p.connected).length;
    const layout = n <= 4 ? `${n} side-by-side sectors` : 'two rows of sectors';
    return `${isHost() ? `<button class="btn rust full" data-action="start" ${n < 2 ? 'disabled' : ''}>OPEN THE MARSH →</button>` : '<p class="hint">The host opens the marsh when the team is ready.</p>'}
      <p class="hint">${n < 2 ? 'At least two observers are needed. Share the code.' : `${n} observers: ${layout}, each overlapping its neighbours by two columns.`}${state.practice ? ' Practice: you are always the Lead Counter.' : ' The Lead Counter rotates each round.'}</p>`;
  }

  // ---------- Clock ----------
  function tick() {
    if (!state || !state.endsAt) return;
    const at = state.paused ? state.paused.since : now();
    const left = Math.max(0, state.endsAt - at), secs = Math.ceil(left / 1000), frac = state.phaseMs ? Math.min(1, left / state.phaseMs) : 0;
    for (const el of app.querySelectorAll('[data-secs]')) el.textContent = el.closest('.timer') ? mmss(secs) : secs;
    const clock = app.querySelector('[data-clock]');
    if (clock) { clock.style.setProperty('--frac', frac.toFixed(3)); clock.classList.toggle('low', secs <= 10 && ['scout', 'lockin'].includes(state.phase) && !state.paused); }
    if (secs !== lastSecond) {
      lastSecond = secs;
      if (['scout', 'lockin'].includes(state.phase) && secs <= 5 && secs > 0 && !state.paused) sound.play('tick');
      if (['scout', 'lockin'].includes(state.phase) && secs > 0 && secs % 15 === 0) announce(`${secs} seconds remaining`);
    }
  }
  setInterval(tick, 250);

  // ---------- Actions ----------
  app.addEventListener('click', async e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab; app.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b === tabBtn)); app.querySelector('.panels').className = `panels tab-${tab}`; return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    if (a === 'invite') {
      const link = `${location.origin}/?count=${state.code}`;
      if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({ title: 'Flyway: The Great Count', text: `Join my count: ${state.code}`, url: link }); } catch {} return; }
      try { await navigator.clipboard.writeText(link); toast('Count link copied.'); } catch { toast(`Share this link: ${link}`); }
      return;
    }
    if (a === 'leave') { leaving = true; send('leave'); ws?.close(); forget(); state = null; viewKey = null; showLanding(); return; }
    if (a === 'start') send('start');
    if (a === 'step' && book) {
      const { sp, key } = el.dataset, d = Number(el.dataset.d);
      const next = Math.max(0, Math.min(30, book[key][sp] + d));
      if (key === 'overlaps' && next > book.tallies[sp]) return toast('Overlap birds are part of what you saw. Raise SEEN first.', 'bad');
      book[key][sp] = next;
      if (key === 'tallies' && book.overlaps[sp] > next) book.overlaps[sp] = next;
      send('notebook', { tallies: book.tallies, overlaps: book.overlaps });
      sound.play('pencil');
      const region = app.querySelector('[data-r="notebook"]'); region.innerHTML = notebookHtml(); region.__html = region.innerHTML;
    }
    if (a === 'share') { send('share'); sound.play('note'); }
    if (a === 'done') { send('done'); sound.play('note'); }
    if (a === 'chip') send('chip', { chip: el.dataset.chip });
    if (a === 'cell') {
      if (!ping.col || !ping.row) return toast('Pick a column and a row first.', 'bad');
      send('chip', { chip: 'cell', cell: ping.col + ping.row, species: ping.species });
    }
    if (a === 'dstep' && draft) {
      const sp = el.dataset.sp; draft.totals[sp] = Math.max(0, Math.min(60, draft.totals[sp] + Number(el.dataset.d)));
      sendDraft();
    }
    if (a === 'file') { sendDraft(); send('file'); }
    if (a === 'back') { send('back'); el.disabled = true; }
    if (a === 'again') send('again');
    if (a === 'share') { const msg = await FX.share(shareText(), 'Flyway: The Great Count'); if (msg) toast(msg); }
    if (a === 'resume') send('resume');
  });
  app.addEventListener('change', e => {
    const p = e.target.dataset.ping;
    if (p) { ping[p] = e.target.value; return; }
    const r = e.target.dataset.rare;
    if (r && draft) {
      const col = app.querySelector('[data-rare="col"]').value, row = app.querySelector('[data-rare="row"]').value;
      draft.rareCell = col && row ? col + row : '';
      sendDraft();
    }
  });
  function sendDraft() {
    send('draft', { totals: draft.totals, rareCell: draft.rareCell });
    sound.play('pencil');
    const region = app.querySelector('[data-r="report"]');
    if (region) { region.innerHTML = reportHtml(); region.__html = region.innerHTML; }
  }

  if (saved.token && saved.code && (!urlCode || urlCode === saved.code)) { silentJoin = true; connect({ type: 'join', code: saved.code, token: saved.token, name: saved.name }); }
})();
