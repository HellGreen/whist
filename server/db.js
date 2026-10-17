// SQLite-database med spillere, spilleaftener (sessions), runder og point.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | saved | ended
  owner_id INTEGER REFERENCES players(id),
  rules TEXT NOT NULL,
  saved_state TEXT
);
CREATE TABLE IF NOT EXISTS session_players (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  seat INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  PRIMARY KEY (session_id, seat)
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  round_no INTEGER NOT NULL,
  played_at TEXT NOT NULL DEFAULT (datetime('now')),
  dealer_id INTEGER REFERENCES players(id),
  declarer_id INTEGER NOT NULL REFERENCES players(id),
  partner_id INTEGER REFERENCES players(id), -- = declarer_id ved selvmakker, NULL ved kvarte/nolo
  solo INTEGER NOT NULL,
  bid_kind TEXT NOT NULL, -- plain | vip | halve | staerke | gode | trumfloese | kvarte | sol | rensol | bord | renbord
  bid_level INTEGER,
  bid_label TEXT NOT NULL,
  trump TEXT,
  called_ace TEXT,
  self_call INTEGER NOT NULL DEFAULT 0,
  vip_flips INTEGER,
  team_tricks INTEGER NOT NULL,
  won INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS round_scores (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  points REAL NOT NULL,
  PRIMARY KEY (round_id, player_id)
);
CREATE INDEX IF NOT EXISTS rounds_session ON rounds(session_id);
-- De 13 kort hver spiller fik (før byttet med katten), mellemrumsadskilt, fx "S14 H2 J1".
CREATE TABLE IF NOT EXISTS round_hands (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  seat INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  cards TEXT NOT NULL,
  PRIMARY KEY (round_id, seat)
);
-- Hvert spillet kort i rækkefølge.
CREATE TABLE IF NOT EXISTS round_plays (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  seq INTEGER NOT NULL, -- 0-51
  trick_no INTEGER NOT NULL, -- 1-13
  seat INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  card TEXT NOT NULL,
  won_trick INTEGER NOT NULL, -- 1 hvis kortet vandt stikket
  think_ms INTEGER, -- betænkningstid: fra turen begyndte, til kortet blev spillet
  PRIMARY KEY (round_id, seq)
);
-- Hvert bud i melderunden.
CREATE TABLE IF NOT EXISTS round_bids (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  seq INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  bid_label TEXT, -- NULL = pas
  hold INTEGER NOT NULL DEFAULT 0,
  think_ms INTEGER,
  PRIMARY KEY (round_id, seq)
);
`;

// Kolonner tilføjet efter første version.
const MIGRATIONS = [
  ['rounds', 'replay', 'TEXT'], // fuldt forløb (kort, meldinger, kat, stik) som JSON til afspilleren
  ['round_plays', 'think_ms', 'INTEGER'],
  ['players', 'bot_profile', 'TEXT'], // NULL = menneske, ellers AI-profil (safe | normal | risky)
];

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const [tableName, column, type] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${tableName})`).all().some(c => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${type}`);
  }

  const q = sql => db.prepare(sql);
  const tx = fn => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const sessionPlayers = id => q(`
    SELECT sp.seat, p.id, p.name FROM session_players sp
    JOIN players p ON p.id = sp.player_id
    WHERE sp.session_id = ? ORDER BY sp.seat`).all(id);

  const sessionTotals = id => Object.fromEntries(q(`
    SELECT rs.player_id AS id, SUM(rs.points) AS points FROM round_scores rs
    JOIN rounds r ON r.id = rs.round_id
    WHERE r.session_id = ? GROUP BY rs.player_id`).all(id).map(r => [r.id, r.points]));

  return {
    upsertPlayer(name) {
      return q(`
        INSERT INTO players (name, last_seen) VALUES (?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen
        RETURNING id, name`).get(name);
    },

    upsertBot(name, profile) {
      return q(`
        INSERT INTO players (name, bot_profile, last_seen) VALUES (?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET bot_profile = excluded.bot_profile, last_seen = excluded.last_seen
        RETURNING id, name`).get(name, profile);
    },

    botProfile(id) {
      return q('SELECT bot_profile FROM players WHERE id = ?').get(id)?.bot_profile ?? null;
    },

    playerName(id) {
      return q('SELECT name FROM players WHERE id = ?').get(id)?.name;
    },

    createSession(ownerId, rules, seats) {
      return tx(() => {
        const { lastInsertRowid } = q('INSERT INTO sessions (owner_id, rules) VALUES (?, ?)')
          .run(ownerId, JSON.stringify(rules));
        const id = Number(lastInsertRowid);
        const insert = q('INSERT INTO session_players (session_id, seat, player_id) VALUES (?, ?, ?)');
        seats.forEach((playerId, seat) => insert.run(id, seat, playerId));
        return id;
      });
    },

    getSession(id) {
      return q('SELECT * FROM sessions WHERE id = ?').get(id);
    },

    // Løbende autogem, så et spil kan genoptages efter en servergenstart.
    storeState(id, state) {
      q('UPDATE sessions SET saved_state = ? WHERE id = ?').run(JSON.stringify(state), id);
    },

    saveSession(id, state) {
      q(`UPDATE sessions SET status = 'saved', saved_state = ? WHERE id = ?`).run(JSON.stringify(state), id);
    },

    activateSession(id) {
      q(`UPDATE sessions SET status = 'active' WHERE id = ?`).run(id);
    },

    endSession(id) {
      q(`UPDATE sessions SET status = 'ended', ended_at = datetime('now'), saved_state = NULL WHERE id = ?`).run(id);
    },

    // Spil der var i gang da serveren stoppede, bliver til gemte borde.
    recoverSessions() {
      q(`UPDATE sessions SET status = CASE WHEN saved_state IS NULL THEN 'ended' ELSE 'saved' END
         WHERE status = 'active'`).run();
    },

    savedSessions() {
      return q(`SELECT id, started_at FROM sessions WHERE status = 'saved' ORDER BY started_at DESC`).all()
        .map(s => ({ id: s.id, startedAt: s.started_at, players: sessionPlayers(s.id) }));
    },

    insertRound(r) {
      tx(() => {
        const { lastInsertRowid } = q(`
          INSERT INTO rounds (session_id, round_no, dealer_id, declarer_id, partner_id, solo, bid_kind,
            bid_level, bid_label, trump, called_ace, self_call, vip_flips, team_tricks, won, replay)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          r.sessionId, r.roundNo, r.dealerId, r.declarerId, r.partnerId, r.solo ? 1 : 0, r.bidKind,
          r.bidLevel, r.bidLabel, r.trump, r.calledAce, r.selfCall ? 1 : 0, r.vipFlips, r.teamTricks, r.won ? 1 : 0,
          r.replay ? JSON.stringify(r.replay) : null);
        const insert = q('INSERT INTO round_scores (round_id, player_id, points) VALUES (?, ?, ?)');
        for (const s of r.scores) insert.run(lastInsertRowid, s.playerId, s.points);
        if (!r.replay) return;
        const hand = q('INSERT INTO round_hands (round_id, seat, player_id, cards) VALUES (?, ?, ?, ?)');
        r.replay.dealt.hands.forEach((cards, seat) => hand.run(lastInsertRowid, seat, r.seatIds[seat], cards.join(' ')));
        const play = q(`INSERT INTO round_plays (round_id, seq, trick_no, seat, player_id, card, won_trick, think_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        r.replay.plays.forEach(({ seat, card, ms }, seq) => {
          const trick = Math.floor(seq / 4);
          play.run(lastInsertRowid, seq, trick + 1, seat, r.seatIds[seat], card,
            r.replay.trickWinners[trick] === seat ? 1 : 0, ms ?? null);
        });
        const bid = q(`INSERT INTO round_bids (round_id, seq, seat, player_id, bid_label, hold, think_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        r.replay.bidLog.forEach((b, seq) => bid.run(lastInsertRowid, seq, b.seat, r.seatIds[b.seat],
          b.pass ? null : b.label, b.hold ? 1 : 0, b.ms ?? null));
      });
    },

    roundReplay(roundId) {
      const r = q('SELECT session_id, round_no, replay FROM rounds WHERE id = ?').get(roundId);
      if (!r?.replay) return null;
      return { roundNo: r.round_no, players: sessionPlayers(r.session_id), ...JSON.parse(r.replay) };
    },

    sessionRounds(id) {
      const scores = {};
      for (const s of q(`
        SELECT rs.round_id, rs.player_id, rs.points FROM round_scores rs
        JOIN rounds r ON r.id = rs.round_id WHERE r.session_id = ?`).all(id)) {
        (scores[s.round_id] ??= {})[s.player_id] = s.points;
      }
      return q(`
        SELECT r.*, d.name AS declarer_name, m.name AS partner_name FROM rounds r
        JOIN players d ON d.id = r.declarer_id
        LEFT JOIN players m ON m.id = r.partner_id
        WHERE r.session_id = ? ORDER BY r.round_no`).all(id).map(r => ({
        id: r.id,
        hasReplay: r.replay != null,
        roundNo: r.round_no,
        playedAt: r.played_at,
        bidLabel: r.bid_label,
        declarer: r.declarer_name,
        partner: r.solo ? (r.partner_id ? 'selvmakker' : 'alene') : r.partner_name,
        teamTricks: r.team_tricks,
        won: !!r.won,
        scores: scores[r.id] ?? {},
      }));
    },

    sessionDetail(id) {
      const s = q('SELECT id, started_at, ended_at, status FROM sessions WHERE id = ?').get(id);
      if (!s) return null;
      return { id: s.id, startedAt: s.started_at, endedAt: s.ended_at, status: s.status,
        players: sessionPlayers(id), rounds: this.sessionRounds(id) };
    },

    sessionList() {
      return q(`
        SELECT s.id, s.started_at, s.ended_at, s.status,
          (SELECT COUNT(*) FROM rounds r WHERE r.session_id = s.id) AS round_count
        FROM sessions s ORDER BY s.started_at DESC`).all()
        .filter(s => s.round_count > 0 || s.status === 'saved')
        .map(s => ({ id: s.id, startedAt: s.started_at, endedAt: s.ended_at, status: s.status,
          rounds: s.round_count, players: sessionPlayers(s.id), totals: sessionTotals(s.id) }));
    },

    stats() {
      return {
        totals: q(`
          SELECT p.name, COUNT(DISTINCT r.session_id) AS sessions, COUNT(*) AS rounds, SUM(rs.points) AS points
          FROM round_scores rs JOIN rounds r ON r.id = rs.round_id JOIN players p ON p.id = rs.player_id
          GROUP BY p.id ORDER BY points DESC`).all(),
        declarer: q(`
          SELECT p.name, r.bid_kind AS kind, COUNT(*) AS played, SUM(r.won) AS won
          FROM rounds r JOIN players p ON p.id = r.declarer_id
          GROUP BY p.id, r.bid_kind ORDER BY p.name, played DESC`).all(),
        pairs: q(`
          SELECT d.name AS declarer, m.name AS partner, COUNT(*) AS played, SUM(r.won) AS won
          FROM rounds r JOIN players d ON d.id = r.declarer_id JOIN players m ON m.id = r.partner_id
          WHERE r.solo = 0 GROUP BY d.id, m.id ORDER BY played DESC`).all(),
        thinking: q(`
          SELECT p.name,
            (SELECT AVG(think_ms) FROM round_bids b WHERE b.player_id = p.id) AS bid_avg,
            (SELECT COUNT(think_ms) FROM round_bids b WHERE b.player_id = p.id) AS bids,
            (SELECT AVG(think_ms) FROM round_plays x WHERE x.player_id = p.id) AS play_avg,
            (SELECT MAX(think_ms) FROM round_plays x WHERE x.player_id = p.id) AS play_max,
            (SELECT COUNT(think_ms) FROM round_plays x WHERE x.player_id = p.id) AS plays
          FROM players p WHERE p.bot_profile IS NULL
          ORDER BY p.name`).all().filter(r => r.bids || r.plays),
      };
    },
  };
}
