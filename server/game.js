// Spilmotor for én runde es-makker whist. Tilstanden er et rent JSON-objekt,
// så den kan gemmes i databasen og genoptages senere.
// Pladser nummereres 0-3 med uret; spilleren efter giveren er forhånd.
import { randomInt } from 'node:crypto';
import { allBids, bidLabel, bidRank, noloDef, parseBid } from './bids.js';
import { UserError } from './errors.js';
import { scoreRound } from './scoring.js';

export const SUITS = ['S', 'H', 'C', 'D'];
export const ACES = SUITS.map(s => s + '14');
export const suitOf = card => card[0];
export const rankOf = card => Number(card.slice(1));
export const isJoker = card => card[0] === 'J';

const FIXED_TRUMP = { gode: 'C', staerke: 'S', trumfloese: 'NT' };

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(s + r);
  deck.push('J1', 'J2', 'J3');
  return deck;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// Jokere først, derefter spar, hjerter, klør, ruder – højeste kort først.
const SORT_ORDER = { J: 0, S: 1, H: 2, C: 3, D: 4 };
export function sortCards(cards) {
  return [...cards].sort((a, b) => SORT_ORDER[a[0]] - SORT_ORDER[b[0]] || rankOf(b) - rankOf(a));
}

export function newRound(dealer, rules, deck = shuffle(makeDeck())) {
  const forehand = (dealer + 1) % 4;
  return {
    rules, dealer, forehand,
    phase: 'bidding', // bidding | passed | contract | halveTrump | vip | exchange | play | roundEnd
    turn: forehand,
    hands: [0, 1, 2, 3].map(i => deck.slice(i * 13, i * 13 + 13)),
    kat: deck.slice(52),
    discards: [],
    bidLog: [],
    passed: [false, false, false, false],
    high: null,
    contract: null,
    trick: [],
    lastTrick: null,
    tricks: [0, 0, 0, 0],
    openHand: false,
    result: null,
  };
}

function expectTurn(s, seat, phase) {
  if (s.phase !== phase) throw new UserError('Det kan du ikke gøre nu');
  if (s.turn !== seat) throw new UserError('Det er ikke din tur');
}

// ---------- Melderunden ----------

const order = (s, seat) => (seat - s.forehand + 4) % 4;

// En melding skal være højere end den gældende. En spiller tidligere i
// melderækkefølgen må dog "holde" (melde det samme som) en senere spiller.
function canBid(s, seat, bid) {
  if (!s.high) return true;
  const r = bidRank(bid), hr = bidRank(s.high.bid);
  return r > hr || (r === hr && order(s, seat) < order(s, s.high.seat));
}

export function allowedBids(s, seat) {
  return allBids(s.rules)
    .filter(b => canBid(s, seat, b))
    .map(b => ({ ...b, label: bidLabel(b), hold: !!s.high && bidRank(b) === bidRank(s.high.bid) }));
}

export function bid(s, seat, raw) {
  expectTurn(s, seat, 'bidding');
  if (raw == null) {
    s.passed[seat] = true;
    s.bidLog.push({ seat, pass: true });
  } else {
    const b = parseBid(raw, s.rules);
    if (!canBid(s, seat, b)) throw new UserError('Meldingen skal være højere end den nuværende');
    const hold = !!s.high && bidRank(b) === bidRank(s.high.bid);
    s.high = { seat, bid: b };
    s.bidLog.push({ seat, bid: b, hold });
  }
  const active = [0, 1, 2, 3].filter(i => !s.passed[i]);
  if (active.length === 0) {
    s.phase = 'passed';
    s.turn = null;
  } else if (active.length === 1 && s.high?.seat === active[0]) {
    finishBidding(s);
  } else {
    let next = (seat + 1) % 4;
    while (s.passed[next]) next = (next + 1) % 4;
    s.turn = next;
  }
}

function finishBidding(s) {
  const { seat, bid: b } = s.high;
  s.contract = {
    declarer: seat, bid: b, label: bidLabel(b),
    trump: null, // S | H | C | D | NT (uden trumf); null = ikke bestemt endnu
    ace: null, partner: null, partnerRevealed: false,
    selfCall: false, katPartner: false,
    vipFlips: 0, vipCards: [],
    exchanger: null, tookKat: false, katCards: [],
  };
  s.turn = seat;
  if (b.nolo) {
    s.contract.trump = 'NT';
    startExchange(s, seat);
  } else {
    s.phase = 'contract';
  }
}

// ---------- Trumf, makker-es, vip og kat ----------

export function chooseContract(s, seat, { trump, ace } = {}) {
  expectTurn(s, seat, 'contract');
  const c = s.contract, sfx = c.bid.suffix;
  if (sfx == null || sfx === 'kvarte') {
    if (!SUITS.includes(trump)) throw new UserError('Vælg en trumffarve');
    c.trump = trump;
  } else if (FIXED_TRUMP[sfx]) {
    c.trump = FIXED_TRUMP[sfx];
  }
  if (sfx !== 'kvarte') {
    if (!ACES.includes(ace)) throw new UserError('Vælg et makker-es');
    if (c.trump && c.trump !== 'NT' && suitOf(ace) === c.trump) {
      throw new UserError('Makker-esset må ikke være i trumffarven');
    }
    c.ace = ace;
    c.selfCall = s.hands[seat].includes(ace);
  }
  if (sfx === 'halve') {
    const holder = s.hands.findIndex(h => h.includes(ace));
    c.katPartner = holder < 0;
    c.partner = holder < 0 ? seat : holder;
    c.partnerRevealed = true; // makker melder trumf og er dermed kendt
    s.phase = 'halveTrump';
    s.turn = c.partner;
  } else if (sfx === 'vip') {
    c.vipFlips = 1;
    c.vipCards = s.kat.slice(0, 1);
    s.phase = 'vip';
  } else {
    startExchange(s, seat);
  }
}

export function halveTrump(s, seat, trump) {
  expectTurn(s, seat, 'halveTrump');
  const c = s.contract;
  if (!SUITS.includes(trump)) throw new UserError('Vælg en trumffarve');
  if (trump === suitOf(c.ace)) throw new UserError('Trumf må ikke være i makker-essets kulør');
  c.trump = trump;
  startExchange(s, seat);
}

export function vip(s, seat, accept) {
  expectTurn(s, seat, 'vip');
  const c = s.contract;
  if (!accept) {
    c.vipFlips++;
    c.vipCards = s.kat.slice(0, c.vipFlips);
    if (c.vipFlips < 3) return; // det tredje kort gælder altid
  }
  const card = s.kat[c.vipFlips - 1];
  c.trump = isJoker(card) ? 'NT' : suitOf(card);
  startExchange(s, c.declarer);
}

function startExchange(s, seat) {
  s.phase = 'exchange';
  s.turn = seat;
  s.contract.exchanger = seat;
}

// Man tager enten hele katten (og lægger 3 kort) eller beholder sine kort.
export function exchange(s, seat, take) {
  expectTurn(s, seat, 'exchange');
  const c = s.contract;
  if (c.tookKat) throw new UserError('Du har allerede taget katten');
  if (!take) return startPlay(s);
  c.tookKat = true;
  c.katCards = s.kat;
  s.hands[seat] = [...s.hands[seat], ...s.kat];
  s.kat = [];
}

export function discard(s, seat, cards) {
  expectTurn(s, seat, 'exchange');
  if (!s.contract.tookKat) throw new UserError('Tag katten først');
  const hand = s.hands[seat];
  if (!Array.isArray(cards) || new Set(cards).size !== 3 || !cards.every(x => hand.includes(x))) {
    throw new UserError('Vælg præcis 3 kort at lægge');
  }
  s.hands[seat] = hand.filter(x => !cards.includes(x));
  s.discards = cards;
  startPlay(s);
}

function startPlay(s) {
  const c = s.contract;
  if (!c.bid.nolo && c.bid.suffix !== 'kvarte' && c.bid.suffix !== 'halve') {
    const holder = s.hands.findIndex(h => h.includes(c.ace));
    c.partner = holder < 0 ? c.declarer : holder;
    c.katPartner = c.partner === c.declarer && !c.selfCall;
  }
  s.phase = 'play';
  s.turn = s.forehand;
}

// ---------- Stikspil ----------

const trumpSuit = s => (s.contract.trump === 'NT' ? null : s.contract.trump);

// Jokere er de højeste trumfer. I spil uden trumf er en joker "fri" og vinder aldrig.
const effectiveSuit = (s, card) => (isJoker(card) ? trumpSuit(s) : suitOf(card));

function ledSuit(s) {
  if (!s.trick.length) return null;
  const first = s.trick[0].card;
  if (!isJoker(first)) return suitOf(first);
  const trump = trumpSuit(s);
  if (trump) return trump;
  const firstReal = s.trick.find(p => !isJoker(p.card));
  return firstReal ? suitOf(firstReal.card) : null;
}

export function legalCards(s, seat) {
  if (s.phase !== 'play' || s.turn !== seat) return [];
  const hand = s.hands[seat];
  const led = ledSuit(s);
  if (!led) return [...hand];
  const c = s.contract;
  // Esmakker skal spille makker-esset, når dets kulør spilles ud.
  if (c.ace && seat !== c.declarer && hand.includes(c.ace) && suitOf(c.ace) === led) return [c.ace];
  const follow = hand.filter(x => effectiveSuit(s, x) === led);
  if (!follow.length) return [...hand];
  return trumpSuit(s) ? follow : [...follow, ...hand.filter(isJoker)];
}

function trickWinner(s) {
  const highest = plays => plays.reduce((a, b) => (rankOf(b.card) > rankOf(a.card) ? b : a));
  const trump = trumpSuit(s);
  if (trump) {
    const joker = s.trick.find(p => isJoker(p.card)); // første joker vinder
    if (joker) return joker.seat;
    const trumps = s.trick.filter(p => suitOf(p.card) === trump);
    if (trumps.length) return highest(trumps).seat;
  }
  const led = ledSuit(s);
  return highest(s.trick.filter(p => !isJoker(p.card) && suitOf(p.card) === led)).seat;
}

export function play(s, seat, card) {
  expectTurn(s, seat, 'play');
  if (!legalCards(s, seat).includes(card)) throw new UserError('Det kort må du ikke spille nu');
  const c = s.contract;
  s.hands[seat] = s.hands[seat].filter(x => x !== card);
  if (!s.trick.length) s.lastTrick = null;
  s.trick.push({ seat, card });
  if (c.bid.nolo && noloDef(c.bid.nolo).open) s.openHand = true;
  if (card === c.ace) c.partnerRevealed = true;
  if (s.trick.length < 4) {
    s.turn = (seat + 1) % 4;
    return;
  }
  const winner = trickWinner(s);
  s.tricks[winner]++;
  s.lastTrick = { cards: s.trick, winner };
  s.trick = [];
  s.turn = winner;
  const failedNolo = c.bid.nolo && s.tricks[c.declarer] > noloDef(c.bid.nolo).maxTricks;
  if (failedNolo || s.tricks.reduce((a, b) => a + b) === 13) {
    s.result = scoreRound(c, s.tricks);
    s.phase = 'roundEnd';
    s.turn = null;
  }
}

// ---------- Visning for én spiller (skjuler andres kort) ----------

export function view(s, seat) {
  const c = s.contract;
  const showPartner = c && (c.partnerRevealed || s.phase === 'roundEnd');
  return {
    phase: s.phase, dealer: s.dealer, forehand: s.forehand, turn: s.turn,
    hand: sortCards(s.hands[seat]),
    handCounts: s.hands.map(h => h.length),
    legal: legalCards(s, seat),
    bidLog: s.bidLog.map(e => (e.pass
      ? { seat: e.seat, pass: true }
      : { seat: e.seat, hold: e.hold, label: bidLabel(e.bid) })),
    allowedBids: s.phase === 'bidding' && s.turn === seat ? allowedBids(s, seat) : [],
    contract: c && {
      declarer: c.declarer, bid: c.bid, label: c.label, trump: c.trump, ace: c.ace,
      partner: showPartner ? c.partner : null,
      katPartner: s.phase === 'roundEnd' ? c.katPartner : false,
      selfCall: s.phase === 'roundEnd' || seat === c.declarer ? c.selfCall : false,
      vipFlips: c.vipFlips, vipCards: c.vipCards,
      exchanger: c.exchanger, tookKat: c.tookKat,
      fromKat: c.exchanger === seat ? c.katCards : [],
    },
    katCount: s.kat.length,
    trick: s.trick,
    lastTrick: s.lastTrick,
    tricks: s.tricks,
    openHand: s.openHand && c.declarer !== seat
      ? { seat: c.declarer, cards: sortCards(s.hands[c.declarer]) }
      : null,
    result: s.result,
  };
}
