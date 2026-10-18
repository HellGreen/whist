// Simulerer spillere mod en kørende server: node tools/simulate.js [url] [runder] [ai]
// Uden "ai" forbinder fire spillere, der vælger tilfældige lovlige handlinger.
// Med "ai" forbinder én spiller, som fylder bordet op med tre AI-spillere.
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3000';
const ROUNDS = Number(process.argv[3] ?? 3);
const WITH_AI = process.argv[4] === 'ai';
const NAMES = WITH_AI ? ['Sim Anna'] : ['Sim Anna', 'Sim Bo', 'Sim Carl', 'Sim Dina'];
const pick = a => a[Math.floor(Math.random() * a.length)];

const bots = NAMES.map(name => {
  const socket = io(URL, { transports: ['websocket'] });
  const bot = { name, socket, state: null };
  socket.on('state', s => { bot.state = s; act(bot); });
  socket.on('toast', m => console.log(`[${name}] toast: ${m}`));
  socket.on('connect', () => socket.emit('hello', name));
  return bot;
});

let done = false;
const lastKey = new Map();

function act(bot) {
  const { state: s, socket } = bot;
  if (done || !s?.me) return;
  const t = s.table;
  if (!t) {
    if (bot === bots[0]) socket.emit('table:create');
    return;
  }
  if (!t.game) {
    if (WITH_AI && t.mySeat >= 0 && t.seats.includes(null)) socket.emit('table:addBot', ['safe', 'normal', 'risky'][t.seats.indexOf(null) - 1]);
    else if (t.mySeat < 0) socket.emit('table:join');
    else if (!t.seats[t.mySeat].ready && t.status === 'waiting') socket.emit('table:ready', true);
    return;
  }
  if (t.rounds.length >= ROUNDS) {
    done = true;
    console.log(JSON.stringify(t.rounds.map(r => ({ nr: r.roundNo, melding: r.bidLabel, melder: r.declarer, makker: r.partner, stik: r.teamTricks, hjem: r.won, point: r.scores })), null, 1));
    const owner = bots.find(b => b.state?.me?.id === t.ownerId);
    owner?.socket.emit('table:end');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const g = t.game, me = t.mySeat;
  // Undgå at sende samme handling flere gange for samme tilstand.
  const key = JSON.stringify([g.phase, g.turn, g.hand.length, g.bidLog.length, g.contract?.vipFlips, g.contract?.tookKat, t.rounds.length]);
  if (lastKey.get(bot) === key) return;
  lastKey.set(bot, key);

  if (g.turn !== me) return;
  const c = g.contract;
  switch (g.phase) {
    case 'bidding':
      socket.emit('game:bid', Math.random() < 0.5 && g.allowedBids.length ? g.allowedBids[Math.floor(Math.random() * 6)] ?? g.allowedBids[0] : null);
      break;
    case 'contract': {
      const trump = pick(['S', 'H', 'C', 'D']);
      const fixed = { gode: 'C', staerke: 'S' }[c.bid.suffix] ?? (['vip', 'halve', 'trumfloese'].includes(c.bid.suffix) ? null : trump);
      const ace = pick(['S', 'H', 'C', 'D'].filter(x => x !== fixed)) + '14';
      socket.emit('game:contract', { trump, ace });
      break;
    }
    case 'halveTrump':
      socket.emit('game:halveTrump', pick(['S', 'H', 'C', 'D'].filter(x => x !== c.ace[0])));
      break;
    case 'vip':
      socket.emit('game:vip', Math.random() < 0.4);
      break;
    case 'exchange':
      if (!c.tookKat) socket.emit('game:exchange', Math.random() < 0.6);
      else socket.emit('game:discard', [...g.hand].sort(() => Math.random() - 0.5).slice(0, 3));
      break;
    case 'cover':
      socket.emit('game:cover', pick(g.hand));
      break;
    case 'play':
      socket.emit('game:play', pick(g.legal));
      break;
  }
}

setTimeout(() => { console.error('Timeout – simuleringen gik i stå'); for (const b of bots) console.error(b.name, JSON.stringify(b.state?.table?.game?.phase), b.state?.table?.status); process.exit(1); }, 60_000 + ROUNDS * 15_000);
