// Webserver: venterum, ét bord, nedtælling, spil, AI-spillere, pause/gem og historik.
import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import * as AI from './ai.js';
import { bidRank, defaultRules, NOLOS, rulesInfo, sanitizeRules } from './bids.js';
import { openDb } from './db.js';
import { UserError } from './errors.js';
import * as G from './game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const LEAVE_GRACE_MS = 15_000; // så et genindlæst faneblad ikke mister pladsen ved bordet
// WHIST_DELAY_FACTOR < 1 gør alle ventetider kortere (bruges til test).
const DELAY = Number(process.env.WHIST_DELAY_FACTOR ?? 1);
// Under 0,2 er det en automatisk test; ellers skal stikanimationen (3,8 sek., TRICK_PHASES i
// public/app.js) nå at blive færdig.
const atLeast = (ms, min) => (DELAY < 0.2 ? ms : Math.max(min, ms));
const RESULT_DELAY_MS = atLeast(2_500 * DELAY, 4_400); // pause efter sidste kort, før scoren vises
const RESULT_SHOW_MS = atLeast(5_000 * DELAY, 5_000); // så længe scoren vises, før næste runde starter
const AUTO_SAVE_MS = 10 * 60_000 * DELAY; // er alle spillere væk så længe under et spil, gemmes bordet
const RULES_INFO = {
  ...rulesInfo(),
  aiProfiles: Object.values(AI.PROFILES).map(({ key, label, desc }) => ({ key, label, desc })),
};

const db = openDb(process.env.WHIST_DB || path.join(ROOT, 'data', 'whist.db'));
db.recoverSessions();

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
const server = createServer(app);
const io = new Server(server);

/** Kendte menneskelige spillere: id -> { id, name, sockets: Set, leaveTimer } */
const players = new Map();
/** AI-spillere: id -> profilnøgle */
const bots = new Map();
/** Det ene bord, eller null. */
let table = null;
let botTimer = null;

const isBot = id => bots.has(id);
const isOnline = id => isBot(id) || (players.get(id)?.sockets.size ?? 0) > 0;
const nameOf = id => players.get(id)?.name ?? db.playerName(id) ?? '?';
const seatOf = id => (table ? table.seats.indexOf(id) : -1);
const inGame = () => table?.status === 'playing' || table?.status === 'paused';

function newTable(ownerId, saved = null) {
  const t = {
    ownerId,
    rules: saved?.rules ?? defaultRules(),
    seats: saved?.seats ?? [ownerId, null, null, null],
    present: new Set([ownerId]), // spillere der sidder ved bordet (vigtigt for genoptagne borde)
    ready: new Set(),
    status: 'waiting', // waiting | countdown | playing | paused
    countdown: 0,
    timer: null,
    reserved: !!saved, // genoptaget bord: kun de oprindelige spillere har plads
    sessionId: saved?.sessionId ?? null,
    savedState: saved?.state ?? null,
    rounds: saved ? db.sessionRounds(saved.sessionId) : [],
    game: null,
    roundTimer: null,
    showResult: false,
    nextRoundAt: 0,
    turnSince: Date.now(), // hvornår den nuværende tur begyndte (til betænkningstid)
    away: new Set(), // spillere der kigger på stilling, historik eller sidste stik
    awayFrom: null, // hvornår spilleren, der har turen, gik væk fra bordet (stopuret holder pause)
    pausedAt: 0,
    autoSaveTimer: null,
  };
  for (const id of t.seats) {
    const profile = id && db.botProfile(id);
    if (profile) {
      bots.set(id, profile);
      t.present.add(id);
      t.ready.add(id);
    }
  }
  return t;
}

const snapshot = () => ({ seats: table.seats, game: table.game });

function closeTable() {
  clearInterval(table.timer);
  clearTimeout(table.roundTimer);
  clearTimeout(table.autoSaveTimer);
  table = null;
}

function toastTable(message) {
  for (const id of table.seats) for (const s of players.get(id)?.sockets ?? []) s.emit('toast', message);
}

function setPaused(paused) {
  if (paused && table.status === 'playing') {
    table.status = 'paused';
    table.pausedAt = Date.now();
  } else if (!paused && table.status === 'paused') {
    table.status = 'playing';
    table.turnSince += Date.now() - table.pausedAt; // pausen tæller ikke med i betænkningstiden
    if (table.awayFrom) table.awayFrom += Date.now() - table.pausedAt;
  }
}

// ---------- Venterum og bord ----------

function leaveTable(id) {
  const seat = seatOf(id);
  if (seat < 0) return;
  if (inGame()) throw new UserError('Spillet er i gang – bordets ejer kan gemme eller afslutte det');
  cancelCountdown();
  table.ready.delete(id);
  table.present.delete(id);
  if (!table.reserved) table.seats[seat] = null;
  if (table.ownerId === id) {
    const next = table.seats.find(p => p && table.present.has(p) && !isBot(p));
    if (next) table.ownerId = next;
    else closeTable();
  }
}

function checkStart() {
  const t = table;
  const allReady = t.seats.every(p => p && t.present.has(p) && t.ready.has(p) && isOnline(p));
  if (!allReady) return cancelCountdown();
  if (t.status !== 'waiting') return;
  t.status = 'countdown';
  t.countdown = 3;
  t.timer = setInterval(() => {
    if (table !== t || t.status !== 'countdown') return clearInterval(t.timer);
    t.countdown--;
    if (t.countdown <= 0) {
      clearInterval(t.timer);
      startGame();
    }
    push();
  }, 1000);
}

function cancelCountdown() {
  if (table?.status !== 'countdown') return;
  clearInterval(table.timer);
  table.status = 'waiting';
}

function startGame() {
  const t = table;
  t.ready.clear();
  for (const id of t.seats) if (isBot(id)) t.ready.add(id);
  t.status = 'playing';
  startTurnClock();
  if (t.savedState) {
    t.game = t.savedState.game;
    t.savedState = null;
    db.activateSession(t.sessionId);
    if (t.game.phase === 'roundEnd') scheduleNextRound();
  } else {
    t.sessionId = db.createSession(t.ownerId, t.rules, t.seats);
    startRound(randomInt(4));
  }
}

// Er alle (menneskelige) spillere ved bordet væk i AUTO_SAVE_MS under et spil, gemmes bordet,
// så det kan genoptages fra "Gemte borde". Kommer én tilbage inden, afbrydes nedtællingen.
function scheduleAutoSave() {
  const t = table;
  if (t.autoSaveTimer || !t.seats.every(id => isBot(id) || !isOnline(id))) return;
  t.autoSaveTimer = setTimeout(() => {
    t.autoSaveTimer = null;
    if (table !== t || !inGame() || t.seats.some(id => !isBot(id) && isOnline(id))) return;
    db.saveSession(t.sessionId, snapshot());
    closeTable();
    console.log('Bordet blev gemt automatisk, fordi alle spillere var væk');
    push();
  }, AUTO_SAVE_MS);
}

function cancelAutoSave() {
  clearTimeout(table?.autoSaveTimer);
  if (table) table.autoSaveTimer = null;
}

function wentOffline(id) {
  if (seatOf(id) < 0) return;
  if (inGame()) scheduleAutoSave();
  if (table.status === 'playing') return setPaused(true);
  if (table.status === 'paused') return;
  table.ready.delete(id);
  cancelCountdown();
  const entry = players.get(id);
  clearTimeout(entry.leaveTimer);
  entry.leaveTimer = setTimeout(() => {
    if (!isOnline(id) && table && !inGame()) {
      leaveTable(id);
      push();
    }
  }, LEAVE_GRACE_MS);
}

function detach(socket) {
  const id = socket.data.playerId;
  if (!id) return;
  socket.data.playerId = null;
  const entry = players.get(id);
  entry.sockets.delete(socket);
  if (!entry.sockets.size) {
    setAway(id, false); // den nye forbindelse starter ved bordet
    wentOffline(id);
  }
}

// ---------- Spillet ----------

function startRound(dealer) {
  table.game = G.newRound(dealer, table.rules);
  table.showResult = false;
  startTurnClock();
  db.storeState(table.sessionId, snapshot());
}

// ---------- Betænkningstid ----------

// Stopuret for den, der har turen, holder pause, mens spilleren er væk fra bordet i klienten
// (stilling, historik, genafspilning eller sidste stik).
function startTurnClock() {
  const t = table, turn = t.game?.turn;
  t.turnSince = Date.now();
  t.awayFrom = turn != null && t.away.has(t.seats[turn]) ? t.turnSince : null;
}

function thinkMs() {
  const now = Date.now();
  return Math.max(0, now - table.turnSince - (table.awayFrom ? now - table.awayFrom : 0));
}

function setAway(id, away) {
  if (!table || seatOf(id) < 0 || away === table.away.has(id)) return;
  if (away) table.away.add(id);
  else table.away.delete(id);
  const turn = table.game?.turn;
  if (turn == null || table.seats[turn] !== id) return;
  if (away) table.awayFrom = Date.now();
  else if (table.awayFrom) {
    table.turnSince += Date.now() - table.awayFrom;
    table.awayFrom = null;
  }
}

function gameAction(id, fn) {
  const seat = seatOf(id);
  if (seat < 0) throw new UserError('Du sidder ikke ved bordet');
  if (table.status === 'paused') throw new UserError('Spillet er sat på pause');
  if (table.status !== 'playing') throw new UserError('Spillet er ikke i gang');
  const g = table.game;
  const before = { phase: g.phase, bids: g.bidLog.length, plays: g.plays?.length ?? 0 };
  const ms = thinkMs();
  fn(g, seat);
  // Betænkningstid: fra turen begyndte, til spilleren traf sit valg.
  if (g.bidLog.length > before.bids) g.bidLog.at(-1).ms = ms;
  else if ((g.plays?.length ?? 0) > before.plays) g.plays.at(-1).ms = ms;
  else (g.decisions ??= []).push({ seat, phase: before.phase, ms });
  startTurnClock();
  db.storeState(table.sessionId, snapshot()); // så spillet kan genoptages præcis her

  if (g.phase === 'passed') {
    toastTable(g.ironHand != null
      ? `${nameOf(table.seats[g.ironHand])} har jernhånd – der gives kort igen`
      : 'Alle meldte pas – der gives kort igen');
    startRound((g.dealer + 1) % 4);
  } else if (g.phase === 'roundEnd' && !g.recorded) {
    g.recorded = true;
    recordRound(g);
    scheduleNextRound();
  }
}

// Efter sidste kort: stikanimationen, så scoren i 5 sekunder, så næste melderunde.
function scheduleNextRound() {
  const t = table, g = t.game;
  clearTimeout(t.roundTimer);
  t.showResult = false;
  t.roundTimer = setTimeout(() => {
    if (table !== t || t.game !== g) return;
    t.showResult = true;
    t.nextRoundAt = Date.now() + RESULT_SHOW_MS;
    push();
    t.roundTimer = setTimeout(() => {
      if (table !== t || t.game !== g) return;
      startRound((g.dealer + 1) % 4);
      push();
    }, RESULT_SHOW_MS);
  }, RESULT_DELAY_MS);
}

function recordRound(g) {
  const c = g.contract, r = g.result, ids = table.seats;
  db.insertRound({
    sessionId: table.sessionId,
    roundNo: table.rounds.length + 1,
    dealerId: ids[g.dealer],
    declarerId: ids[c.declarer],
    partnerId: c.partner == null ? null : ids[c.partner],
    solo: r.solo,
    bidKind: c.bid.nolo ?? c.bid.suffix ?? 'plain',
    bidLevel: c.bid.n ?? null,
    bidLabel: c.label,
    trump: c.trump,
    calledAce: c.ace,
    selfCall: c.selfCall,
    vipFlips: c.vipFlips || null,
    teamTricks: r.teamTricks,
    won: r.won,
    joiners: (r.soloists ?? []).slice(1).map(x => ({ playerId: ids[x.seat], won: x.won ? 1 : 0, tricks: x.tricks })),
    scores: ids.map((playerId, i) => ({ playerId, points: r.points[i] })),
    seatIds: ids,
    replay: G.replayOf(g),
  });
  table.rounds = db.sessionRounds(table.sessionId);
  db.storeState(table.sessionId, snapshot());
}

// ---------- AI-spillere ----------

function botDelay(g) {
  if (g.phase === 'play' && !g.trick.length && g.lastTrick) return atLeast(DELAY * (4200 + randomInt(600)), 4100); // efter stikanimationen
  if (g.phase === 'bidding') return DELAY * (1000 + randomInt(1200));
  return DELAY * (700 + randomInt(900));
}

function scheduleBots() {
  if (botTimer || table?.status !== 'playing') return;
  const t = table, g = t.game;
  if (!g || g.turn == null || !isBot(t.seats[g.turn])) return;
  const seat = g.turn, id = t.seats[seat];
  botTimer = setTimeout(() => {
    botTimer = null;
    if (table !== t || t.game !== g || g.turn !== seat || t.status !== 'playing') return scheduleBots();
    try {
      botAct(id, AI.decide(g, seat, bots.get(id)));
    } catch (err) {
      console.error('AI-fejl, bruger nødløsning:', err);
      botAct(id, fallbackDecision(g, seat));
    }
    push();
  }, botDelay(g));
}

function botAct(id, d) {
  gameAction(id, (g, seat) => {
    switch (d.type) {
      case 'bid': return G.bid(g, seat, d.bid);
      case 'contract': return G.chooseContract(g, seat, d);
      case 'halveTrump': return G.halveTrump(g, seat, d.trump);
      case 'vip': return G.vip(g, seat, d.accept);
      case 'exchange': return G.exchange(g, seat, d.take);
      case 'discard': return G.discard(g, seat, d.cards);
      case 'cover': return G.cover(g, seat, d.card);
      case 'play': return G.play(g, seat, d.card);
      default: throw new Error(`Ukendt AI-handling ${d.type}`);
    }
  });
}

// Hvis AI'en fejler, vælges en simpel lovlig handling, så spillet ikke går i stå.
function fallbackDecision(g, seat) {
  switch (g.phase) {
    case 'bidding': return { type: 'bid', bid: null };
    case 'contract': return { type: 'contract', trump: 'S', ace: G.ACES.find(a => a[0] !== 'S' && !g.hands[seat].includes(a)) ?? 'H14' };
    case 'halveTrump': return { type: 'halveTrump', trump: G.SUITS.find(s => s !== g.contract.ace[0]) };
    case 'vip': return { type: 'vip', accept: true };
    case 'exchange': return { type: 'exchange', take: false };
    case 'cover': return { type: 'cover', card: g.hands[seat][0] };
    default: return { type: 'play', card: G.legalCards(g, seat)[0] };
  }
}

function addBot(profile) {
  if (!AI.PROFILES[profile]) throw new UserError('Ukendt AI-profil');
  const label = AI.PROFILES[profile].label;
  const taken = new Set(table.seats.filter(Boolean).map(nameOf));
  let name = `AI ${label}`;
  for (let i = 2; taken.has(name); i++) name = `AI ${label} ${i}`;
  const { id } = db.upsertBot(name, profile);
  bots.set(id, profile);
  return id;
}

// ---------- Visning ----------

function tableView(id) {
  const t = table, seat = seatOf(id);
  return {
    ownerId: t.ownerId,
    status: t.status,
    countdown: t.countdown,
    reserved: t.reserved,
    rules: t.rules,
    mySeat: seat,
    sessionId: t.sessionId,
    seats: t.seats.map(p => p && {
      id: p, name: nameOf(p), online: isOnline(p), present: t.present.has(p), ready: t.ready.has(p),
      bot: isBot(p) ? AI.PROFILES[bots.get(p)]?.label ?? 'AI' : null,
    }),
    game: t.game && seat >= 0 ? G.view(t.game, seat) : null,
    showResult: t.showResult,
    nextRoundIn: t.showResult ? Math.max(0, t.nextRoundAt - Date.now()) : 0,
    trickWinners: t.game?.trickWinners ?? [],
    rounds: t.rounds,
  };
}

function viewFor(id) {
  return {
    me: id ? { id, name: nameOf(id) } : null,
    online: [...players.values()].filter(p => p.sockets.size)
      .map(p => ({ id: p.id, name: p.name, atTable: seatOf(p.id) >= 0 })),
    table: table && tableView(id),
    saved: table ? [] : db.savedSessions(),
    rulesInfo: RULES_INFO,
  };
}

function push() {
  for (const socket of io.sockets.sockets.values()) socket.emit('state', viewFor(socket.data.playerId));
  scheduleBots();
}

// ---------- Socket-hændelser ----------

io.on('connection', socket => {
  const on = (event, fn) => socket.on(event, (...args) => {
    const ack = typeof args.at(-1) === 'function' ? args.pop() : null;
    try {
      const data = fn(...args);
      ack?.({ ok: true, data });
    } catch (err) {
      if (!(err instanceof UserError)) console.error(err);
      const error = err instanceof UserError ? err.message : 'Der opstod en fejl på serveren';
      if (ack) ack({ ok: false, error });
      else socket.emit('toast', error);
    }
    push();
  });
  const me = () => {
    const id = socket.data.playerId;
    if (!id) throw new UserError('Skriv dit navn først');
    return id;
  };
  const owner = () => {
    const id = me();
    if (!table || table.ownerId !== id) throw new UserError('Kun bordets ejer kan gøre det');
    return id;
  };
  const atTable = () => {
    const id = me();
    if (!table?.present.has(id)) throw new UserError('Du sidder ikke ved bordet');
    return id;
  };
  const game = fn => (...args) => gameAction(me(), (g, seat) => fn(g, seat, ...args));

  on('hello', raw => {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 20) throw new UserError('Navnet skal være 1–20 tegn');
    if (/^AI\b/i.test(name)) throw new UserError('Navne der starter med "AI" er forbeholdt AI-spillere');
    detach(socket);
    const p = db.upsertPlayer(name);
    let entry = players.get(p.id);
    if (!entry) players.set(p.id, entry = { id: p.id, name: p.name, sockets: new Set(), leaveTimer: null });
    clearTimeout(entry.leaveTimer);
    entry.sockets.add(socket);
    socket.data.playerId = p.id;
    if (seatOf(p.id) >= 0) cancelAutoSave();
    if (table?.status === 'paused' && table.seats.every(isOnline)) setPaused(false);
    return { id: p.id, name: p.name };
  });

  on('logout', () => detach(socket));

  on('table:create', () => {
    const id = me();
    if (table) throw new UserError('Der er allerede et bord');
    table = newTable(id);
  });

  on('table:resume', sessionId => {
    const id = me();
    if (table) throw new UserError('Der er allerede et bord');
    const s = db.getSession(Number(sessionId));
    if (s?.status !== 'saved') throw new UserError('Det gemte bord findes ikke');
    const state = JSON.parse(s.saved_state);
    if (!state.seats.includes(id)) throw new UserError('Du var ikke med ved det bord');
    table = newTable(id, { sessionId: s.id, rules: JSON.parse(s.rules), seats: state.seats, state });
  });

  on('table:join', () => {
    const id = me();
    if (!table) throw new UserError('Der er intet bord');
    if (inGame()) throw new UserError('Spillet er allerede i gang');
    if (seatOf(id) < 0) {
      if (table.reserved) throw new UserError('Kun spillerne fra det gemte bord kan sætte sig');
      const free = table.seats.indexOf(null);
      if (free < 0) throw new UserError('Bordet er fuldt');
      table.seats[free] = id;
    }
    table.present.add(id);
  });

  on('table:leave', () => leaveTable(me()));

  on('table:addBot', profile => {
    atTable();
    if (table.status !== 'waiting' || table.reserved) throw new UserError('Der kan ikke tilføjes AI-spillere nu');
    const free = table.seats.indexOf(null);
    if (free < 0) throw new UserError('Bordet er fuldt');
    const id = addBot(profile);
    table.seats[free] = id;
    table.present.add(id);
    table.ready.add(id);
    checkStart();
  });

  on('table:removeBot', seat => {
    atTable();
    const id = table.seats[Number(seat)];
    if (!isBot(id)) throw new UserError('Der sidder ingen AI-spiller der');
    if (table.status !== 'waiting' || table.reserved) throw new UserError('AI-spilleren kan ikke fjernes nu');
    table.seats[Number(seat)] = null;
    table.present.delete(id);
    table.ready.delete(id);
  });

  on('table:rules', rules => {
    owner();
    if (table.status !== 'waiting' || table.reserved) throw new UserError('Reglerne kan ikke ændres nu');
    table.rules = sanitizeRules(rules);
    for (const id of table.seats) if (id && !isBot(id)) table.ready.delete(id); // alle skal se de nye regler
  });

  on('table:ready', flag => {
    const id = atTable();
    if (inGame()) return;
    if (flag) table.ready.add(id);
    else table.ready.delete(id);
    checkStart();
  });

  on('table:save', () => {
    owner();
    if (inGame()) db.saveSession(table.sessionId, snapshot());
    closeTable();
  });

  on('table:end', () => {
    owner();
    if (inGame()) db.endSession(table.sessionId);
    closeTable();
  });

  on('game:bid', game((g, seat, b) => G.bid(g, seat, b)));
  on('game:contract', game((g, seat, choice) => G.chooseContract(g, seat, choice)));
  on('game:halveTrump', game((g, seat, trump) => G.halveTrump(g, seat, trump)));
  on('game:vip', game((g, seat, accept) => G.vip(g, seat, !!accept)));
  on('game:exchange', game((g, seat, take) => G.exchange(g, seat, !!take)));
  on('game:discard', game((g, seat, cards) => G.discard(g, seat, cards)));
  on('game:cover', game((g, seat, card) => G.cover(g, seat, card)));
  on('game:play', game((g, seat, card) => G.play(g, seat, card)));
  on('game:away', away => setAway(me(), !!away));

  on('history:list', () => db.sessionList());
  on('history:session', id => db.sessionDetail(Number(id)));
  on('history:replay', roundId => {
    const replay = db.roundReplay(Number(roundId));
    if (!replay) throw new UserError('Runden kan ikke afspilles');
    return replay;
  });
  on('stats', sessionId => {
    const stats = db.stats(sessionId ? Number(sessionId) : null);
    const rank = r => bidRank(NOLOS.some(x => x.key === r.kind)
      ? { nolo: r.kind } : { n: r.level, suffix: r.kind === 'plain' ? null : r.kind });
    stats.bids.sort((a, b) => rank(a) - rank(b));
    return stats;
  });

  socket.on('disconnect', () => {
    detach(socket);
    push();
  });

  socket.emit('state', viewFor(null));
});

server.listen(PORT, () => console.log(`Whist kører på http://localhost:${PORT}`));
