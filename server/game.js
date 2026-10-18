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

// Spar, hjerter, klør, ruder med laveste kort først – jokerne yderst til højre.
// I nolo-spil (sol osv.) tæller esset som 1 og vises derfor først i hver kulør.
const SORT_ORDER = { S: 0, H: 1, C: 2, D: 3, J: 4 };
export function sortCards(cards, aceLow = false) {
  const rank = c => (aceLow && rankOf(c) === 14 ? 1 : rankOf(c));
  return [...cards].sort((a, b) => SORT_ORDER[a[0]] - SORT_ORDER[b[0]] || rank(a) - rank(b));
}

export function newRound(dealer, rules, deck = shuffle(makeDeck())) {
  const forehand = (dealer + 1) % 4;
  const hands = [0, 1, 2, 3].map(i => deck.slice(i * 13, i * 13 + 13));
  return {
    rules, dealer, forehand,
    phase: 'bidding', // bidding | passed | contract | halveTrump | vip | exchange | cover | play | roundEnd
    turn: forehand,
    hands,
    kat: deck.slice(52),
    dealt: { hands: hands.map(h => [...h]), kat: deck.slice(52) }, // til afspilning
    plays: [], // { seat, card } i spillet rækkefølge
    trickWinners: [],
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

// En melding skal være højere end den gældende. Med reglen "hold" må en spiller
// tidligere i melderækkefølgen dog melde det samme som en senere spiller.
function canBid(s, seat, bid) {
  if (!s.high) return true;
  const r = bidRank(bid), hr = bidRank(s.high.bid);
  // Gemte spil fra før reglen fandtes, havde "hold" slået til. Nolo kan ikke holdes – man går med i stedet.
  const mayHold = s.rules.hold !== false && !bid.nolo;
  return r > hr || (mayHold && r === hr && order(s, seat) < order(s, s.high.seat));
}

// "Gå med" på en nolo-melding: man spiller samme nolo som melderen, men hver for sig.
export function canJoin(s, seat) {
  return s.phase === 'bidding' && s.turn === seat && !!s.high?.bid.nolo
    && s.high.seat !== seat && !(s.high.joined ?? []).includes(seat);
}

// Jernhånd: ingen billedkort (B, D, K), esser eller jokere. Spilleren kan kræve, at der gives om.
export const isIronHand = hand => hand.every(c => !isJoker(c) && rankOf(c) <= 10);

export function canIronHand(s, seat) {
  return s.phase === 'bidding' && s.turn === seat && s.rules.jernhaand !== false && isIronHand(s.hands[seat]);
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
  } else if (raw.iron) {
    if (!canIronHand(s, seat)) throw new UserError('Du har ikke jernhånd');
    s.bidLog.push({ seat, iron: true });
    s.ironHand = seat;
    s.phase = 'passed';
    s.turn = null;
    return;
  } else if (raw.join) {
    if (!canJoin(s, seat)) throw new UserError('Du kan ikke gå med nu');
    (s.high.joined ??= []).push(seat);
    s.bidLog.push({ seat, bid: s.high.bid, join: true });
  } else {
    const b = parseBid(raw, s.rules);
    if (!canBid(s, seat, b)) throw new UserError('Meldingen skal være højere end den nuværende');
    const hold = !!s.high && bidRank(b) === bidRank(s.high.bid);
    s.high = { seat, bid: b, joined: [] }; // et overbud nulstiller dem, der gik med
    s.bidLog.push({ seat, bid: b, hold });
  }
  // Melderunden slutter, når alle der ikke har passet, har den højeste melding eller er gået med på den.
  const group = s.high ? [s.high.seat, ...(s.high.joined ?? [])] : [];
  const active = [0, 1, 2, 3].filter(i => !s.passed[i]);
  if (active.length === 0) {
    s.phase = 'passed';
    s.turn = null;
  } else if (active.every(i => group.includes(i))) {
    finishBidding(s);
  } else {
    let next = (seat + 1) % 4;
    while (s.passed[next] || group.includes(next)) next = (next + 1) % 4;
    s.turn = next;
  }
}

function finishBidding(s) {
  const { seat, bid: b } = s.high;
  // Ved nolo: melderen og dem der gik med (i rækkefølge efter melderen). De bytter med katten efter tur.
  const joined = (s.high.joined ?? []).slice().sort((x, y) => ((x - seat + 4) % 4) - ((y - seat + 4) % 4));
  s.contract = {
    soloists: b.nolo ? [seat, ...joined] : undefined,
    exchangeQueue: b.nolo ? joined : [],
    exchanges: [],
    declarer: seat, bid: b, label: bidLabel(b),
    trump: null, // S | H | C | D | NT (uden trumf); null = ikke bestemt endnu
    ace: null, partner: null, partnerRevealed: false,
    selfCall: false, katPartner: false,
    vipFlips: 0, vipCards: [],
    exchanger: null, tookKat: false, katCards: [],
    covered: null, coveredPlayed: null, // fordækt kort (se cover)
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
  if (!take) return exchangeDone(s, seat);
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
  exchangeDone(s, seat);
}

// Når en har byttet: næste der gik med på nolo, kan bytte med de 3 kort der blev lagt
// (eller med katten, hvis den ikke blev taget). Ellers starter spillet.
function exchangeDone(s, seat) {
  const c = s.contract;
  (c.exchanges ??= []).push({ seat, took: c.tookKat, discards: c.tookKat ? s.discards : [] });
  const next = c.exchangeQueue?.shift();
  if (next == null) return startPlay(s);
  if (c.tookKat) s.kat = s.discards;
  c.tookKat = false;
  c.katCards = [];
  startExchange(s, next);
}

function startPlay(s) {
  const c = s.contract;
  if (!c.bid.nolo && c.bid.suffix !== 'kvarte' && c.bid.suffix !== 'halve') {
    const holder = s.hands.findIndex(h => h.includes(c.ace));
    c.partner = holder < 0 ? c.declarer : holder;
    c.katPartner = c.partner === c.declarer && !c.selfCall;
  }
  if (mayCover(s)) {
    s.phase = 'cover';
    s.turn = c.declarer;
    return;
  }
  beginTricks(s);
}

function beginTricks(s) {
  s.phase = 'play';
  s.turn = s.forehand;
}

// ---------- Fordækt kort ----------

// Har melderen ingen kort i makker-essets kulør (efter katten), skal vedkommende inden første udspil
// lægge et vilkårligt kort fordækt. Det tæller som laveste kort i essets kulør og må kun bruges til at
// spille ud i kuløren eller lægges, første gang kuløren spilles. Det vises aldrig for bordet.
function mayCover(s) {
  const c = s.contract;
  if (!c.ace) return false;
  return !s.hands[c.declarer].some(x => !isJoker(x) && suitOf(x) === suitOf(c.ace));
}

export function cover(s, seat, card) {
  expectTurn(s, seat, 'cover');
  const c = s.contract;
  if (!s.hands[seat].includes(card)) throw new UserError('Vælg et kort fra din hånd at lægge fordækt');
  s.hands[seat] = s.hands[seat].filter(x => x !== card);
  c.covered = card;
  beginTricks(s);
}

// ---------- Stikspil ----------

export const trumpSuit = s => (s.contract.trump === 'NT' ? null : s.contract.trump);
export const soloistsOf = c => c.soloists ?? [c.declarer]; // nolo-spillerne (gemte spil havde kun melderen)

// Jokere: spilles en joker ud som første kort, vinder den stikket, og de andre må lægge
// hvad som helst (der er ingen kulør at bekende). Ellers har en joker ingen værdi og må kun
// lægges, når man ikke kan bekende kulør. Jokere må ikke spilles ud i første stik.
// Et fordækt kort i et stik har `as` = makker-essets kulør og tæller som laveste kort i den.
export const isJokerPlay = p => !p.as && isJoker(p.card);
export const playSuit = p => (isJokerPlay(p) ? null : p.as ?? suitOf(p.card));

export function ledSuitOf(trick) {
  const firstReal = trick.find(p => !isJokerPlay(p));
  return firstReal ? playSuit(firstReal) : null;
}
const ledSuit = s => ledSuitOf(s.trick);

export function legalCards(s, seat) {
  if (s.phase !== 'play' || s.turn !== seat) return [];
  const hand = s.hands[seat], c = s.contract;
  const covered = seat === c.declarer ? c.covered : null;
  if (covered && !hand.length) return [covered]; // kun det fordækte kort tilbage
  if (!s.trick.length) {
    const firstTrick = !(s.trickWinners?.length ?? s.tricks.reduce((a, b) => a + b, 0));
    return [...(firstTrick ? hand.filter(x => !isJoker(x)) : hand), ...(covered ? [covered] : [])];
  }
  if (isJokerPlay(s.trick[0])) return [...hand]; // joker spillet ud: frit valg
  const led = ledSuit(s);
  if (!led) return [...hand];
  if (covered && led === suitOf(c.ace)) return [covered]; // det fordækte kort bekender essets kulør
  // Esmakker skal spille makker-esset, når dets kulør spilles ud.
  if (c.ace && seat !== c.declarer && hand.includes(c.ace) && suitOf(c.ace) === led) return [c.ace];
  const follow = hand.filter(x => !isJoker(x) && suitOf(x) === led);
  return follow.length ? follow : [...hand];
}

// Vinderen af et (evt. ufærdigt) stik, eller null hvis intet kort kan vinde endnu.
// aceLow: i nolo-spil (sol osv.) tæller esset som 1.
export function trickWinnerOf(trick, trump, aceLow = false) {
  const rank = p => (p.as ? 0 : aceLow && rankOf(p.card) === 14 ? 1 : rankOf(p.card));
  const highest = plays => plays.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  if (trick.length && isJokerPlay(trick[0])) return trick[0].seat; // joker spillet ud vinder altid
  if (trump) {
    const trumps = trick.filter(p => playSuit(p) === trump);
    if (trumps.length) return highest(trumps).seat;
  }
  const led = ledSuitOf(trick);
  const following = trick.filter(p => playSuit(p) === led);
  return following.length ? highest(following).seat : null;
}
const trickWinner = s => trickWinnerOf(s.trick, trumpSuit(s), !!s.contract.bid.nolo);

export function play(s, seat, card) {
  expectTurn(s, seat, 'play');
  if (!legalCards(s, seat).includes(card)) throw new UserError('Det kort må du ikke spille nu');
  const c = s.contract;
  const entry = { seat, card };
  if (seat === c.declarer && card === c.covered) {
    entry.as = suitOf(c.ace);
    c.coveredPlayed = card;
    c.covered = null;
  }
  s.hands[seat] = s.hands[seat].filter(x => x !== card);
  if (!s.trick.length) s.lastTrick = null;
  s.trick.push(entry);
  (s.plays ??= []).push(entry);
  if (c.bid.nolo && noloDef(c.bid.nolo).open) s.openHand = true;
  if (card === c.ace) {
    c.partnerRevealed = true;
    c.acePlayed = true;
  }
  if (s.trick.length < 4) {
    s.turn = (seat + 1) % 4;
    return;
  }
  const winner = trickWinner(s);
  s.tricks[winner]++;
  (s.trickWinners ??= []).push(winner);
  s.lastTrick = { cards: s.trick, winner };
  s.trick = [];
  s.turn = winner;
  // Nolo: spillet fortsætter, til alle nolo-spillere har taget for mange stik (eller 13 stik er spillet).
  const allFailed = c.bid.nolo && soloistsOf(c).every(x => s.tricks[x] > noloDef(c.bid.nolo).maxTricks);
  if (allFailed || s.tricks.reduce((a, b) => a + b) === 13) {
    s.result = scoreRound(c, s.tricks);
    s.phase = 'roundEnd';
    s.turn = null;
  }
}

// ---------- Afspilning ----------

// Alt der skal til for at afspille en færdig runde kort for kort.
export function replayOf(s) {
  if (!s.dealt) return null; // runde startet før afspilning fandtes
  const c = s.contract;
  return {
    dealer: s.dealer,
    forehand: s.forehand,
    dealt: s.dealt,
    bidLog: s.bidLog.map(e => (e.pass
      ? { seat: e.seat, pass: true, ms: e.ms }
      : { seat: e.seat, hold: e.hold, join: e.join, label: bidLabel(e.bid), ms: e.ms })),
    decisions: s.decisions ?? [], // betænkningstid for trumf/es, vip og kat
    contract: {
      declarer: c.declarer, label: c.label, nolo: !!c.bid.nolo, trump: c.trump, ace: c.ace, partner: c.partner,
      selfCall: c.selfCall, katPartner: c.katPartner, vipCards: c.vipCards,
      exchanger: c.exchanges?.[0]?.seat ?? c.exchanger, tookKat: c.exchanges?.[0]?.took ?? c.tookKat,
      discards: c.exchanges?.[0]?.discards ?? (c.tookKat ? s.discards : []),
      exchanges: c.exchanges, soloists: c.bid.nolo ? soloistsOf(c) : undefined,
      coveredPlayed: c.coveredPlayed,
    },
    plays: s.plays,
    trickWinners: s.trickWinners,
    result: s.result,
  };
}

// Det senest afsluttede stik – også efter at næste stik er gået i gang (til "se sidste stik").
function lastCompleted(s) {
  const n = s.trickWinners?.length ?? 0;
  if (!n || !s.plays) return null;
  return { no: n, cards: s.plays.slice((n - 1) * 4, n * 4).map(hideCovered), winner: s.trickWinners[n - 1] };
}

// Det fordækte kort vises med bagsiden opad ('X') – også efter det er spillet.
const hideCovered = ({ seat, card, as }) => (as ? { seat, card: 'X', covered: true } : { seat, card });

// ---------- Visning for én spiller (skjuler andres kort) ----------

export function view(s, seat) {
  const c = s.contract;
  // Makkers navn vises først, når makker-esset er spillet (eller runden er slut).
  const showPartner = c && (c.acePlayed || s.phase === 'roundEnd');
  return {
    phase: s.phase, dealer: s.dealer, forehand: s.forehand, turn: s.turn,
    hand: sortCards(s.hands[seat], !!c?.bid.nolo),
    handCounts: s.hands.map(h => h.length),
    legal: legalCards(s, seat),
    bidLog: s.bidLog.map(e => (e.pass || e.iron
      ? { seat: e.seat, pass: e.pass, iron: e.iron }
      : { seat: e.seat, hold: e.hold, join: e.join, label: bidLabel(e.bid) })),
    allowedBids: s.phase === 'bidding' && s.turn === seat ? allowedBids(s, seat) : [],
    joinNolo: canJoin(s, seat) ? s.high.bid.nolo : null, // den nolo-melding man kan gå med på
    canIronHand: canIronHand(s, seat),
    contract: c && {
      declarer: c.declarer, bid: c.bid, label: c.label, trump: c.trump, ace: c.ace,
      alone: !!c.bid.nolo || c.bid.suffix === 'kvarte',
      partner: showPartner ? c.partner : null,
      katPartner: s.phase === 'roundEnd' ? c.katPartner : false,
      selfCall: s.phase === 'roundEnd' || seat === c.declarer ? c.selfCall : false,
      vipFlips: c.vipFlips, vipCards: c.vipCards,
      exchanger: c.exchanger, tookKat: c.tookKat,
      fromKat: c.exchanger === seat ? c.katCards : [],
      soloists: c.bid.nolo ? soloistsOf(c) : undefined,
      // Hvem der har byttet før (ikke hvilke kort – dem ser kun den, der tager dem).
      exchanges: (c.exchanges ?? []).map(({ seat: who, took }) => ({ seat: who, took })),
      hasCovered: !!c.covered, // ligger der et fordækt kort, som ikke er spillet endnu
      covered: seat === c.declarer ? c.covered : null,
      coveredPlayed: s.phase === 'roundEnd' || seat === c.declarer ? c.coveredPlayed : null,
    },
    katCount: s.kat.length,
    trick: s.trick.map(hideCovered),
    lastTrick: s.lastTrick && { ...s.lastTrick, cards: s.lastTrick.cards.map(hideCovered) },
    lastCompleted: lastCompleted(s),
    tricks: s.tricks,
    // Bordlægger: nolo-spillernes kort ligger åbent efter første udspil.
    openHands: s.openHand ? soloistsOf(c).filter(x => x !== seat).map(x => ({ seat: x, cards: sortCards(s.hands[x], true) })) : [],
    result: s.result,
  };
}
