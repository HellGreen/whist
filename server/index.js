// Webserver: venterum, ét bord, nedtælling, spil, pause/gem og historik.
import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { defaultRules, rulesInfo, sanitizeRules } from './bids.js';
import { openDb } from './db.js';
import { UserError } from './errors.js';
import * as G from './game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const LEAVE_GRACE_MS = 15_000; // så et genindlæst faneblad ikke mister pladsen ved bordet
const RULES_INFO = rulesInfo();

const db = openDb(process.env.WHIST_DB || path.join(ROOT, 'data', 'whist.db'));
db.recoverSessions();

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
const server = createServer(app);
const io = new Server(server);

/** Kendte spillere: id -> { id, name, sockets: Set, leaveTimer } */
const players = new Map();
/** Det ene bord, eller null. */
let table = null;

const isOnline = id => (players.get(id)?.sockets.size ?? 0) > 0;
const nameOf = id => players.get(id)?.name ?? db.playerName(id) ?? '?';
const seatOf = id => (table ? table.seats.indexOf(id) : -1);
const inGame = () => table?.status === 'playing' || table?.status === 'paused';

function newTable(ownerId, saved = null) {
  return {
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
    nextReady: new Set(),
  };
}

const snapshot = () => ({ seats: table.seats, game: table.game, nextReady: [...table.nextReady] });

function closeTable() {
  clearInterval(table.timer);
  table = null;
}

function toastTable(message) {
  for (const id of table.seats) for (const s of players.get(id)?.sockets ?? []) s.emit('toast', message);
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
    const next = table.seats.find(p => p && table.present.has(p));
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
  t.status = 'playing';
  if (t.savedState) {
    t.game = t.savedState.game;
    t.nextReady = new Set(t.savedState.nextReady);
    t.savedState = null;
    db.activateSession(t.sessionId);
  } else {
    t.sessionId = db.createSession(t.ownerId, t.rules, t.seats);
    startRound(randomInt(4));
  }
}

function wentOffline(id) {
  if (seatOf(id) < 0) return;
  if (table.status === 'playing') {
    table.status = 'paused';
    return;
  }
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
  if (!entry.sockets.size) wentOffline(id);
}

// ---------- Spillet ----------

function startRound(dealer) {
  table.game = G.newRound(dealer, table.rules);
  table.nextReady.clear();
  db.storeState(table.sessionId, snapshot());
}

function gameAction(id, fn) {
  const seat = seatOf(id);
  if (seat < 0) throw new UserError('Du sidder ikke ved bordet');
  if (table.status === 'paused') throw new UserError('Spillet er sat på pause');
  if (table.status !== 'playing') throw new UserError('Spillet er ikke i gang');
  fn(table.game, seat);
  const g = table.game;
  if (g.phase === 'passed') {
    toastTable('Alle meldte pas – der gives kort igen');
    startRound((g.dealer + 1) % 4);
  } else if (g.phase === 'roundEnd' && !g.recorded) {
    g.recorded = true;
    recordRound(g);
  }
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
    scores: ids.map((playerId, i) => ({ playerId, points: r.points[i] })),
  });
  table.rounds = db.sessionRounds(table.sessionId);
  db.storeState(table.sessionId, snapshot());
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
    seats: t.seats.map(p => p && {
      id: p, name: nameOf(p), online: isOnline(p), present: t.present.has(p), ready: t.ready.has(p),
    }),
    game: t.game && seat >= 0 ? G.view(t.game, seat) : null,
    nextReady: t.seats.map(p => t.nextReady.has(p)),
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
  const game = fn => (...args) => gameAction(me(), (g, seat) => fn(g, seat, ...args));

  on('hello', raw => {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 20) throw new UserError('Navnet skal være 1–20 tegn');
    detach(socket);
    const p = db.upsertPlayer(name);
    let entry = players.get(p.id);
    if (!entry) players.set(p.id, entry = { id: p.id, name: p.name, sockets: new Set(), leaveTimer: null });
    clearTimeout(entry.leaveTimer);
    entry.sockets.add(socket);
    socket.data.playerId = p.id;
    if (table?.status === 'paused' && table.seats.every(isOnline)) table.status = 'playing';
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

  on('table:rules', rules => {
    owner();
    if (table.status !== 'waiting' || table.reserved) throw new UserError('Reglerne kan ikke ændres nu');
    table.rules = sanitizeRules(rules);
    table.ready.clear(); // alle skal se de nye regler, før de er klar
  });

  on('table:ready', flag => {
    const id = me();
    if (!table?.present.has(id)) throw new UserError('Du sidder ikke ved bordet');
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
  on('game:play', game((g, seat, card) => G.play(g, seat, card)));

  on('game:next', () => {
    const id = me();
    if (seatOf(id) < 0 || table.status !== 'playing' || table.game.phase !== 'roundEnd') return;
    table.nextReady.add(id);
    if (table.nextReady.size === 4) startRound((table.game.dealer + 1) % 4);
  });

  on('history:list', () => db.sessionList());
  on('history:session', id => db.sessionDetail(Number(id)));
  on('stats', () => db.stats());

  socket.on('disconnect', () => {
    detach(socket);
    push();
  });

  socket.emit('state', viewFor(null));
});

server.listen(PORT, () => console.log(`Whist kører på http://localhost:${PORT}`));
