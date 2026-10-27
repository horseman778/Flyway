const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3003;
const ROOT = __dirname;

// Timers and limits (PRD sections 3, 6 and 7). TIME_SCALE speeds every timer up for automated tests.
const SCALE = Number(process.env.TIME_SCALE) || 1;
const SCOUT_MS = 75000 * SCALE, LOCKIN_MS = 25000 * SCALE, REVEAL_MS = 15000 * SCALE, SCORES_MS = 8000 * SCALE;
const LEAD_BONUS_MS = 15000 * SCALE, HOST_GRACE_MS = 15000 * SCALE, PAUSE_LIMIT_MS = 60000 * SCALE, ROOM_IDLE_MS = 30 * 60 * 1000;
const ROUNDS = 5, MAX_PLAYERS = 8, MAX_ROOMS = 200, COLS = 'ABCDEFGHIJKLMNOPQRSTUVWX', W = 24, H = 8;
const TARGETS = ['Heron', 'Avocet', 'Tern'];
const CHIPS = { overlap: 'Check your overlap.', rare: 'Rare bird?', agreed: 'Agreed.', hold: 'Hold on.', recount: 'Recounting my sector.' };
const BOT_NAMES = ['Observer Wren', 'Observer Finch'];
// Target birds per species by round, decoys and rare bird (PRD section 3).
const ROUND_PLAN = [
  { range: [2, 4], decoys: 0, rare: false, overlapShare: 4 },
  { range: [3, 5], decoys: 0, rare: true, overlapShare: 4 },
  { range: [4, 6], decoys: 2, rare: true, overlapShare: 4 },
  { range: [5, 8], decoys: 3, rare: true, overlapShare: 3 },
  { range: [6, 9], decoys: 4, rare: true, overlapShare: 3 },
];

const rooms = new Map();

const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/fx.js': 'fx.js', '/style.css': 'style.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = PUBLIC_FILES[pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(ROOT, file)).pipe(res);
});

// Minimal RFC 6455 text socket support keeps the game dependency-free.
function frame(opcode, payload = Buffer.alloc(0)) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}
class Peer {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.readyState = 1; this.handlers = {}; this.recent = [];
    socket.on('data', chunk => this.consume(chunk));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  on(name, fn) { (this.handlers[name] ??= []).push(fn); }
  emit(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
  send(data) { if (this.readyState === 1) this.socket.write(frame(1, data)); }
  close() { if (this.readyState !== 1) return; this.socket.end(frame(8)); this.closed(); }
  closed() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 15, masked = !!(this.buffer[1] & 128);
      let len = this.buffer[1] & 127, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > 4096n) return this.close(); len = Number(big); offset = 10; }
      if (len > 4096) return this.close();
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + len) return;
      let data = this.buffer.subarray(offset + maskBytes, offset + maskBytes + len);
      if (masked) { data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= this.buffer[offset + (i % 4)]; }
      this.buffer = this.buffer.subarray(offset + maskBytes + len);
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.socket.write(frame(10, data)); continue; }
      if (opcode === 1) this.emit('message', data);
    }
  }
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const peer = new Peer(socket);
  peer.on('message', buf => {
    const now = Date.now();
    peer.recent = peer.recent.filter(t => now - t < 1000);
    if (peer.recent.length >= 15) return;
    peer.recent.push(now);
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return send(peer, 'error', { message: 'The field journal could not record that.' }); }
    if (msg && typeof msg === 'object') handle(peer, msg);
  });
  peer.on('close', () => onDisconnect(peer));
});

const uid = () => crypto.randomBytes(12).toString('hex');
const send = (ws, type, data = {}) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type, ...data })); };
const cleanName = value => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const newCode = () => { let c; do { c = ''; for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]; } while (rooms.has(c)); return c; };
const roster = room => [...room.players.values()];
const humans = room => roster(room).filter(p => !p.isBot);
const onlineHumans = room => humans(room).filter(p => p.connected);
const observers = room => roster(room).filter(p => p.observing);
const cellName = (x, y) => COLS[x] + (y + 1);
const validCell = c => typeof c === 'string' && /^[A-X][1-8]$/.test(c);
const emptyBook = () => ({ tallies: { Heron: 0, Avocet: 0, Tern: 0 }, overlaps: { Heron: 0, Avocet: 0, Tern: 0 }, shared: false });

// Seeded generator: a round's scene can be rebuilt from its seed (PRD 6.2).
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- Scene generation ----------
// Vertical bands that overlap their neighbours by exactly two columns.
function bands(count) {
  const total = W + 2 * (count - 1), widths = Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
  const out = []; let start = 0;
  for (const w of widths) { out.push([start, start + w - 1]); start += w - 2; }
  return out;
}
// 2-4 observers: one row of bands. 5-8: two rows of bands sharing one row (PRD section 3).
function layout(ids) {
  const n = ids.length;
  if (n <= 4) return bands(n).map(([x0, x1], i) => ({ playerId: ids[i], x0, x1, y0: 0, y1: H - 1, post: i + 1 }));
  const top = Math.ceil(n / 2), bottom = n - top;
  return [
    ...bands(top).map(([x0, x1], i) => ({ playerId: ids[i], x0, x1, y0: 0, y1: 4, post: i + 1 })),
    ...bands(bottom).map(([x0, x1], i) => ({ playerId: ids[top + i], x0, x1, y0: 4, y1: H - 1, post: top + i + 1 })),
  ];
}
const inside = (s, x, y) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
function coverage(sectors) {
  const cov = Array.from({ length: H }, () => Array(W).fill(0));
  for (const s of sectors) for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) cov[y][x]++;
  return cov;
}
function generate(round, ids, seed) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const random = rng(seed + attempt * 7919);
    const pickIndex = n => Math.floor(random() * n);
    const plan = ROUND_PLAN[round - 1];
    const sectors = layout(ids), cov = coverage(sectors);
    const counts = Object.fromEntries(TARGETS.map(s => [s, plan.range[0] + pickIndex(plan.range[1] - plan.range[0] + 1)]));
    const totalTargets = Object.values(counts).reduce((a, b) => a + b, 0);
    // Birds sit only in cells seen by one or two observers, so every double count is a clean pair.
    const cells = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (cov[y][x] === 1 || cov[y][x] === 2) cells.push({ x, y, shared: cov[y][x] === 2 });
    const taken = new Set(), birds = [];
    const free = c => !taken.has(`${c.x},${c.y}`) && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => taken.has(`${c.x + dx},${c.y + dy}`));
    const place = (species, pool, extra = {}) => {
      const options = pool.filter(free);
      if (!options.length) return false;
      const c = options[pickIndex(options.length)];
      taken.add(`${c.x},${c.y}`);
      birds.push({ id: `b${birds.length + 1}`, species, x: c.x, y: c.y, cell: cellName(c.x, c.y), shared: c.shared, decoy: false, rare: false, ...extra });
      return true;
    };
    // Overlap guarantee (PRD 6.2 step 4).
    const queue = TARGETS.flatMap(s => Array(counts[s]).fill(s));
    for (let i = queue.length - 1; i > 0; i--) { const j = pickIndex(i + 1); [queue[i], queue[j]] = [queue[j], queue[i]]; }
    const needShared = Math.ceil(totalTargets / plan.overlapShare);
    let ok = true;
    queue.forEach((s, i) => { ok = ok && place(s, i < needShared ? cells.filter(c => c.shared) : cells); });
    for (let i = 0; i < plan.decoys && ok; i++) ok = place(i % 2 ? 'Dunlin' : 'Egret', cells, { decoy: true });
    if (plan.rare && ok) ok = place('Spoonbill', cells, { rare: true });
    if (!ok) continue;
    const scene = { round, seed, sectors, birds, counts };
    if (solvable(scene)) return scene;
  }
  throw new Error('Could not build a solvable marsh');
}
// PRD 6.2 step 6: summing sector counts and subtracting birds seen twice must recover the true totals.
function solvable(scene) {
  return TARGETS.every(sp => {
    const list = scene.birds.filter(b => b.species === sp);
    const seen = scene.sectors.reduce((n, s) => n + list.filter(b => inside(s, b.x, b.y)).length, 0);
    const twice = list.filter(b => scene.sectors.filter(s => inside(s, b.x, b.y)).length === 2).length;
    const never = list.filter(b => !scene.sectors.some(s => inside(s, b.x, b.y))).length;
    return never === 0 && seen - twice === scene.counts[sp] && list.every(b => scene.sectors.filter(s => inside(s, b.x, b.y)).length <= 2);
  });
}
function sectorTruth(scene, sector) {
  const mine = scene.birds.filter(b => inside(sector, b.x, b.y) && !b.decoy && !b.rare);
  return { tallies: Object.fromEntries(TARGETS.map(s => [s, mine.filter(b => b.species === s).length])),
    overlaps: Object.fromEntries(TARGETS.map(s => [s, mine.filter(b => b.species === s && b.shared).length])) };
}

// ---------- State sent to each client ----------
function viewFor(room, viewer) {
  const scene = room.scene, revealed = ['reveal', 'scores', 'final'].includes(room.phase);
  const sector = scene?.sectors.find(s => s.playerId === viewer?.id);
  const view = {
    code: room.code, phase: room.phase, hostId: room.hostId, practice: room.practice, serverNow: Date.now(), endsAt: room.endsAt, phaseMs: room.phaseMs,
    round: room.round, rounds: ROUNDS, leadId: room.leadId, teamScore: room.teamScore, results: room.results,
    paused: room.paused ? { since: room.paused.since, until: room.paused.since + PAUSE_LIMIT_MS } : null,
    players: roster(room).map(p => ({ id: p.id, name: p.name, isBot: p.isBot, connected: p.connected || p.isBot, observing: p.observing, spectator: !p.observing && room.phase !== 'lobby' })),
    feed: room.feed.slice(-30),
    sectors: scene ? scene.sectors.map(({ playerId, x0, x1, y0, y1, post }) => ({ playerId, x0, x1, y0, y1, post })) : [],
    // Only birds inside the viewer's own sector, as species and cell, with no ids (PRD 6.1).
    mine: sector && !revealed ? scene.birds.filter(b => inside(sector, b.x, b.y)).map(b => ({ species: b.species, cell: b.cell })) : null,
    notebook: viewer?.notebook || null,
    sheet: observers(room).filter(p => p.notebook?.shared).map(p => ({ id: p.id, name: p.name, isBot: p.isBot, tallies: p.notebook.tallies, overlaps: p.notebook.overlaps })),
    draft: room.phase === 'lockin' || revealed ? room.draft : null,
    backers: room.backers,
    done: roster(room).filter(p => p.done).map(p => p.id),
    awards: room.phase === 'final' ? awards(room) : null,
  };
  if (revealed && scene) view.reveal = { birds: scene.birds.map(b => ({ species: b.species, cell: b.cell, x: b.x, y: b.y, shared: b.shared, decoy: b.decoy, rare: b.rare })), counts: scene.counts, result: room.results.at(-1) };
  return view;
}
function broadcast(room) { for (const p of room.players.values()) if (p.connected && !p.isBot) send(p.ws, 'state', { state: viewFor(room, p) }); }
function setTimer(room, ms) { room.endsAt = Date.now() + ms; room.phaseMs = ms; }
function addFeed(room, entry) { room.feed.push({ id: uid().slice(0, 8), at: Date.now(), ...entry }); if (room.feed.length > 60) room.feed.shift(); }

// ---------- Rooms ----------
function makePlayer(name, ws, extra = {}) {
  return { id: uid(), token: uid(), name, ws, connected: !!ws, awaySince: null, joinedAt: Date.now(), isBot: false, observing: false, notebook: null,
    stats: { sectorError: 0, overlapError: 0, rounds: 0, leadBest: null }, ...extra };
}
function createRoom(ws, name, practice) {
  if (rooms.size >= MAX_ROOMS) return send(ws, 'error', { message: 'Every watchpost is taken. Try again shortly.' });
  const host = makePlayer(name, ws);
  const room = { code: newCode(), hostId: host.id, hostGraceUntil: null, players: new Map([[host.id, host]]), practice, phase: 'lobby', round: 0,
    teamScore: 0, results: [], feed: [], scene: null, draft: null, backers: [], leadId: null, endsAt: null, phaseMs: 0, paused: null, activity: Date.now() };
  if (practice) for (const n of BOT_NAMES) { const b = makePlayer(n, null, { isBot: true, token: null }); room.players.set(b.id, b); }
  rooms.set(room.code, room);
  attach(ws, room, host);
  broadcast(room);
}
function attach(ws, room, player) { ws.player = { room: room.code, id: player.id }; send(ws, 'joined', { code: room.code, token: player.token, id: player.id }); }

// ---------- Round flow: SCOUT > LOCK-IN > REVEAL > SCORES ----------
function startRound(room) {
  room.round++;
  const team = roster(room).filter(p => p.connected || p.isBot);
  for (const p of roster(room)) { p.observing = team.includes(p); p.notebook = p.observing ? emptyBook() : null; p.botShareAt = null; p.done = false; }
  // The human is always Lead in practice; otherwise the Lead rotates each round (PRD 3, 7).
  const leads = team.filter(p => !p.isBot);
  room.leadId = room.practice ? leads[0]?.id : leads[(room.round - 1) % leads.length]?.id;
  room.scene = generate(room.round, team.map(p => p.id), crypto.randomInt(2 ** 31));
  room.draft = { totals: { Heron: 0, Avocet: 0, Tern: 0 }, rareCell: '' };
  room.backers = []; room.feed = [];
  room.phase = 'scout';
  setTimer(room, SCOUT_MS);
  // Bots tally their sector with 85% accuracy and report overlaps truthfully 80% of the time (PRD 7).
  for (const b of team.filter(p => p.isBot)) {
    const truth = sectorTruth(room.scene, room.scene.sectors.find(s => s.playerId === b.id));
    for (const sp of TARGETS) {
      const off = () => (crypto.randomInt(2) ? 1 : -1);
      b.notebook.tallies[sp] = Math.max(0, truth.tallies[sp] + (crypto.randomInt(100) < 85 ? 0 : off()));
      b.notebook.overlaps[sp] = Math.min(b.notebook.tallies[sp], Math.max(0, truth.overlaps[sp] + (crypto.randomInt(100) < 80 ? 0 : off())));
    }
    b.botShareAt = Date.now() + (20000 + crypto.randomInt(20000)) * SCALE;
  }
  if (room.round === 1) addFeed(room, { kind: 'system', text: room.practice ? 'Trust but verify: bot observers are good, not perfect.' : 'Steady. Check your overlap before you report.' });
  broadcast(room);
}
function checkAllDone(room) {
  const people = observers(room).filter(p => !p.isBot && p.connected);
  if (room.phase !== 'scout' || !people.length || !people.every(p => p.done)) return false;
  // Bots finish their notes at once so nobody waits on them.
  for (const b of observers(room).filter(p => p.isBot && !p.notebook.shared)) { b.notebook.shared = true; b.botShareAt = null; addFeed(room, { kind: 'system', text: `${b.name} shared a notebook to the Team Sheet.` }); }
  addFeed(room, { kind: 'system', text: 'Everyone is done scouting. Lock-in starts early.' });
  lockIn(room);
  return true;
}
function lockIn(room) {
  room.phase = 'lockin';
  setTimer(room, LOCKIN_MS);
  addFeed(room, { kind: 'system', text: `Pencils down. ${room.players.get(room.leadId)?.name || 'The Lead'} files the count.` });
  broadcast(room);
}
// PRD 6.5: score the Lead's report, or their current draft if time runs out.
function resolve(room, filed) {
  const scene = room.scene, report = room.draft;
  const species = {};
  for (const sp of TARGETS) {
    const truth = scene.counts[sp], said = report.totals[sp], error = Math.abs(said - truth);
    const raw = observers(room).filter(p => p.notebook?.shared).reduce((n, p) => n + p.notebook.tallies[sp], 0);
    const twice = scene.birds.filter(b => b.species === sp && b.shared);
    species[sp] = { truth, said, error, points: Math.max(0, 100 - 25 * error), raw, sharedCells: twice.map(b => b.cell) };
  }
  const rare = scene.birds.find(b => b.rare);
  const rareRight = !!rare && report.rareCell === rare.cell;
  const perfect = TARGETS.every(sp => species[sp].error === 0);
  const points = TARGETS.reduce((n, sp) => n + species[sp].points, 0) + (rareRight ? 100 : 0) + (perfect ? 100 : 0);
  // Individual accuracy against each observer's own sector (PRD 6.5 step 3).
  const observersReport = observers(room).map(p => {
    const truth = sectorTruth(scene, scene.sectors.find(s => s.playerId === p.id));
    const sectorError = TARGETS.reduce((n, sp) => n + Math.abs(p.notebook.tallies[sp] - truth.tallies[sp]), 0);
    const overlapError = TARGETS.reduce((n, sp) => n + Math.abs(p.notebook.overlaps[sp] - truth.overlaps[sp]), 0);
    if (!p.isBot) { p.stats.sectorError += sectorError; p.stats.overlapError += overlapError; p.stats.rounds++; }
    return { id: p.id, name: p.name, isBot: p.isBot, shared: p.notebook.shared, sectorError, overlapError, tallies: p.notebook.tallies, truth: truth.tallies };
  });
  const lead = room.players.get(room.leadId);
  if (lead && !lead.isBot) lead.stats.leadBest = Math.max(lead.stats.leadBest ?? 0, points);
  room.teamScore += points;
  room.results.push({ round: room.round, filed, leadName: lead?.name || 'The Lead', species, rare: rare ? { cell: rare.cell, said: report.rareCell, right: rareRight } : null, perfect, points,
    decoys: scene.birds.filter(b => b.decoy).map(b => ({ species: b.species, cell: b.cell })), observers: observersReport });
  room.phase = 'reveal';
  setTimer(room, REVEAL_MS);
  broadcast(room);
}
function finishReveal(room) {
  if (room.round >= ROUNDS) { room.phase = 'final'; room.endsAt = null; room.phaseMs = 0; }
  else { room.phase = 'scores'; setTimer(room, SCORES_MS); }
  broadcast(room);
}
function awards(room) {
  const people = humans(room).filter(p => p.stats.rounds);
  const low = key => [...people].sort((a, b) => a.stats[key] / a.stats.rounds - b.stats[key] / b.stats.rounds)[0];
  const sharp = low('sectorError'), detective = low('overlapError');
  const steady = people.filter(p => p.stats.leadBest != null).sort((a, b) => b.stats.leadBest - a.stats.leadBest)[0];
  const score = room.teamScore;
  return {
    title: score >= 1900 ? 'Ornithologists' : score >= 1400 ? 'Wardens' : score >= 800 ? 'Observers' : 'Apprentices',
    sharp: sharp && { name: sharp.name, detail: `${sharp.stats.sectorError} tally error${sharp.stats.sectorError === 1 ? '' : 's'} in ${sharp.stats.rounds} rounds` },
    detective: detective && { name: detective.name, detail: `${detective.stats.overlapError} overlap error${detective.stats.overlapError === 1 ? '' : 's'}` },
    steady: steady && { name: steady.name, detail: `${steady.stats.leadBest} points as Lead` },
  };
}
function passLead(room, extraTime) {
  const next = onlineHumans(room).filter(p => p.observing && p.id !== room.leadId)[0] || onlineHumans(room).find(p => p.id !== room.leadId);
  if (!next) return;
  room.leadId = next.id;
  if (extraTime && room.phase === 'lockin') { room.endsAt += LEAD_BONUS_MS; room.phaseMs += LEAD_BONUS_MS; }
  addFeed(room, { kind: 'system', text: `${next.name} is now the Lead Counter.${extraTime && room.phase === 'lockin' ? ' 15 more seconds.' : ''}` });
}

// ---------- Messages ----------
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function handle(ws, msg) {
  const now = Date.now();
  if (msg.type === 'create' || msg.type === 'practice') {
    const name = cleanName(msg.name);
    if (name.length < 2) return send(ws, 'error', { message: 'Use a name between 2 and 14 characters.' });
    return createRoom(ws, name, msg.type === 'practice');
  }
  if (msg.type === 'join') {
    const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
    if (!room) return send(ws, 'error', { message: 'No count is running under that code.', code: 'no-room' });
    const returning = msg.token && humans(room).find(p => p.token === msg.token);
    if (returning) {
      if (returning.connected && returning.ws && returning.ws !== ws) send(returning.ws, 'error', { message: 'You opened this count in another tab.', code: 'replaced' });
      returning.ws = ws; returning.connected = true; returning.awaySince = null; room.activity = now;
      attach(ws, room, returning);
      return broadcast(room);
    }
    const name = cleanName(msg.name);
    if (name.length < 2) return send(ws, 'error', { message: 'Use a name between 2 and 14 characters.' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, 'error', { message: 'This count is full. Eight observers at most.' });
    if (roster(room).some(p => p.name.toLowerCase() === name.toLowerCase())) return send(ws, 'error', { message: 'That name is already in the field book. Add a number.', code: 'name-taken' });
    const player = makePlayer(name, ws);
    room.players.set(player.id, player); room.activity = now;
    if (!room.players.get(room.hostId)) room.hostId = player.id;
    attach(ws, room, player);
    return broadcast(room);
  }

  const room = ws.player && rooms.get(ws.player.room);
  const player = room?.players.get(ws.player.id);
  if (!room || !player || player.ws !== ws) return send(ws, 'error', { message: 'Join a count first.', code: 'no-room' });
  room.activity = now;
  const isHost = player.id === room.hostId, isLead = player.id === room.leadId;

  switch (msg.type) {
    case 'leave':
      room.players.delete(player.id); ws.player = null;
      return afterDeparture(room, player);
    case 'start':
      if (!isHost || room.phase !== 'lobby') return;
      if (roster(room).filter(p => p.connected || p.isBot).length < 2) return send(ws, 'error', { message: 'At least two observers are needed.' });
      room.round = 0; room.teamScore = 0; room.results = [];
      for (const p of roster(room)) p.stats = { sectorError: 0, overlapError: 0, rounds: 0, leadBest: null };
      return startRound(room);
    case 'notebook': {
      if (room.phase !== 'scout' || room.paused || !player.observing) return;
      const t = msg.tallies || {}, o = msg.overlaps || {};
      if (!TARGETS.every(sp => intIn(t[sp], 0, 30) && intIn(o[sp], 0, 30) && o[sp] <= t[sp])) return send(ws, 'reject', { message: 'Tallies run 0 to 30, and overlap can’t exceed what you saw.' });
      for (const sp of TARGETS) { player.notebook.tallies[sp] = t[sp]; player.notebook.overlaps[sp] = o[sp]; }
      if (player.notebook.shared) return broadcast(room);
      return send(ws, 'state', { state: viewFor(room, player) });
    }
    case 'done':
      // "I'm done scouting": shares the notebook too. When every observer is done, lock-in starts early.
      if (room.phase !== 'scout' || !player.observing || room.paused) return;
      if (!player.notebook.shared) { player.notebook.shared = true; addFeed(room, { kind: 'system', text: `${player.name} shared a notebook to the Team Sheet.` }); }
      player.done = !player.done;
      return checkAllDone(room) || broadcast(room);
    case 'share':
      if (room.phase !== 'scout' || !player.observing) return;
      player.notebook.shared = true;
      addFeed(room, { kind: 'system', text: `${player.name} shared a notebook to the Team Sheet.` });
      return broadcast(room);
    case 'chip': {
      if (!['scout', 'lockin'].includes(room.phase)) return;
      if (now - (player.lastChipAt || 0) < 800) return;
      player.lastChipAt = now;
      let text = CHIPS[msg.chip];
      if (msg.chip === 'cell') {
        if (!validCell(msg.cell)) return send(ws, 'reject', { message: 'Pick a column and a row first.' });
        const sp = ['Heron', 'Avocet', 'Tern', 'Spoonbill', 'Egret', 'Dunlin'].includes(msg.species) ? msg.species.toLowerCase() : 'one';
        text = `I see ${sp === 'one' ? 'one' : (/^[aeiou]/.test(sp) ? 'an ' : 'a ') + sp} at ${msg.cell}.`;
      }
      if (!text) return;
      addFeed(room, { kind: 'chip', from: player.name, text });
      return broadcast(room);
    }
    case 'draft': {
      // The Lead's draft is shared live; if time runs out it is what gets filed (PRD 4.2).
      if (room.phase !== 'lockin' || !isLead || room.paused) return;
      const t = msg.totals || {};
      if (!TARGETS.every(sp => intIn(t[sp], 0, 60)) || !(msg.rareCell === '' || validCell(msg.rareCell))) return send(ws, 'reject', { message: 'Check the totals and the rare-bird cell.' });
      room.draft = { totals: Object.fromEntries(TARGETS.map(sp => [sp, t[sp]])), rareCell: msg.rareCell };
      return broadcast(room);
    }
    case 'file':
      if (room.phase !== 'lockin' || !isLead || room.paused) return;
      return resolve(room, true);
    case 'back':
      if (room.phase !== 'lockin' || isLead || room.backers.includes(player.id)) return;
      room.backers.push(player.id);
      addFeed(room, { kind: 'chip', from: player.name, text: 'backs the Lead. 👍' });
      return broadcast(room);
    case 'again':
      if (!isHost || room.phase !== 'final') return;
      room.phase = 'lobby'; room.round = 0; room.scene = null; room.results = []; room.teamScore = 0; room.feed = []; room.endsAt = null;
      for (const p of roster(room)) { p.observing = false; p.notebook = null; }
      return broadcast(room);
    case 'resume':
      if (isHost && room.paused) { room.paused = null; room.phase = 'lobby'; room.endsAt = null; room.scene = null; broadcast(room); }
      return;
  }
}

function onDisconnect(ws) {
  const room = ws.player && rooms.get(ws.player.room);
  const player = room?.players.get(ws.player.id);
  if (!player || player.ws !== ws) return;
  player.connected = false; player.awaySince = Date.now(); player.ws = null;
  afterDeparture(room, player);
}
function afterDeparture(room, player) {
  if (player.id === room.hostId) { if (!room.players.has(player.id)) passHost(room); else room.hostGraceUntil = Date.now() + HOST_GRACE_MS; }
  // A departing Lead hands the role on; in LOCK-IN the new Lead gets 15 more seconds (PRD 6.6).
  if (player.id === room.leadId && ['scout', 'lockin'].includes(room.phase)) passLead(room, true);
  if (!room.players.has(player.id) && player.observing) addFeed(room, { kind: 'system', text: `${player.name} left their watchpost. Their notes stay on the sheet.` });
  broadcast(room);
}
function passHost(room) {
  const next = onlineHumans(room).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.hostGraceUntil = null;
  if (next) room.hostId = next.id;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!onlineHumans(room).length) {
      room.emptySince ??= now;
      if (now - room.emptySince > 10 * 60 * 1000) { rooms.delete(code); continue; }
    } else room.emptySince = null;
    if (now - room.activity > ROOM_IDLE_MS) { rooms.delete(code); continue; }

    let changed = false;
    if (room.hostGraceUntil && now > room.hostGraceUntil) {
      if (!room.players.get(room.hostId)?.connected) passHost(room); else room.hostGraceUntil = null;
      changed = true;
    }
    if (room.phase === 'lobby') {
      for (const p of humans(room)) if (!p.connected && now - p.awaySince > 60000 * SCALE) { room.players.delete(p.id); changed = true; if (p.id === room.hostId) passHost(room); }
      if (changed) broadcast(room);
      continue;
    }
    // Under two connected observers the count pauses; after a minute it returns to the lobby (PRD 6.6).
    const live = ['scout', 'lockin'].includes(room.phase);
    const short = room.practice ? onlineHumans(room).length === 0 : roster(room).filter(p => p.connected).length < 2;
    if (live && short && !room.paused) { room.paused = { since: now, remaining: Math.max(0, room.endsAt - now) }; broadcast(room); continue; }
    if (room.paused) {
      if (!short) { room.endsAt = now + room.paused.remaining; room.paused = null; broadcast(room); }
      else if (now - room.paused.since > PAUSE_LIMIT_MS) { room.paused = null; room.phase = 'lobby'; room.scene = null; room.endsAt = null; broadcast(room); }
      continue;
    }
    if (room.phase === 'scout') for (const b of roster(room)) if (b.isBot && b.botShareAt && now >= b.botShareAt) {
      b.botShareAt = null; b.notebook.shared = true;
      addFeed(room, { kind: 'system', text: `${b.name} shared a notebook to the Team Sheet.` });
      changed = true;
    }
    if (room.endsAt && now >= room.endsAt) {
      if (room.phase === 'scout') lockIn(room);
      else if (room.phase === 'lockin') resolve(room, false);
      else if (room.phase === 'reveal') finishReveal(room);
      else if (room.phase === 'scores') startRound(room);
      continue;
    }
    if (changed) broadcast(room);
  }
}, 200).unref();

module.exports = { generate, solvable, layout };
if (require.main === module) server.listen(PORT, () => console.log(`Flyway is open at http://localhost:${PORT}`));
