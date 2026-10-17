// AI-spillere. De ser kun deres egen hånd og det, der er offentligt ved bordet
// (meldinger, spillede kort, kendt makker), og træffer valg ud fra simple tommelfingerregler.
import { bidRank } from './bids.js';
import {
  ACES, SUITS, allowedBids, isJoker, ledSuitOf, legalCards, rankOf, suitOf, trickWinnerOf, trumpSuit,
} from './game.js';

export const PROFILES = {
  safe: {
    key: 'safe', label: 'Forsigtig', desc: 'Melder lavt og sikkert og laver få fejl.',
    margin: -0.5, noloSlack: 0.5, vipLength: 4, gamble: 0.02,
  },
  normal: {
    key: 'normal', label: 'Normal', desc: 'Melder realistisk og laver nogle fejl.',
    margin: 0, noloSlack: 1.5, vipLength: 3, gamble: 0.05,
  },
  risky: {
    key: 'risky', label: 'Vovehals', desc: 'Melder højt, går gerne efter sol og tager chancer i spillet.',
    margin: 1, noloSlack: 2.5, vipLength: 3, gamble: 0.08,
  },
};

const ranksIn = (hand, suit) => hand.filter(c => !isJoker(c) && suitOf(c) === suit).map(rankOf).sort((a, b) => b - a);
const jokersIn = hand => hand.filter(isJoker).length;
const pick = list => list[Math.floor(Math.random() * list.length)];
const cardValue = c => (isJoker(c) ? 20 : rankOf(c));
const noloValue = c => (isJoker(c) ? 20 : rankOf(c) === 14 ? 1 : rankOf(c)); // esset er 1 i nolo-spil
const lowest = (cards, value = cardValue) => [...cards].sort((a, b) => value(a) - value(b))[0];
const highest = (cards, value = cardValue) => [...cards].sort((a, b) => value(b) - value(a))[0];

// ---------- Vurdering af hånden ----------

// Forventet antal stik på egen hånd med den givne trumf (null = uden trumf).
// En joker giver et sikkert stik, når den spilles ud.
export function ownTricks(hand, trump) {
  const trumpLength = trump ? ranksIn(hand, trump).length : 0;
  let tricks = jokersIn(hand);
  for (const suit of SUITS) {
    const r = ranksIn(hand, suit);
    if (suit === trump) {
      if (r.includes(14)) tricks += 1;
      if (r.includes(13) && trumpLength >= 2) tricks += r.includes(14) ? 1 : 0.6;
      if (r.includes(12) && trumpLength >= 3) tricks += 0.5;
      tricks += Math.max(0, trumpLength - 3) * 0.9;
    } else {
      if (r.includes(14)) tricks += 1;
      if (r.includes(13) && r.length >= 2) tricks += r.includes(14) ? 0.8 : 0.4;
      if (trump && trumpLength >= 3) {
        if (r.length === 0) tricks += 0.8;
        else if (r.length === 1 && r[0] !== 14) tricks += 0.4;
      }
      if (!trump && r.length >= 5) tricks += r.length - 4;
    }
  }
  return tricks;
}

function bestTrump(hand, exclude = null) {
  return SUITS.filter(s => s !== exclude)
    .map(suit => ({ suit, tricks: ownTricks(hand, suit) }))
    .sort((a, b) => b.tricks - a.tricks)[0];
}

// Hvor mange kort risikerer at tage stik i et nolo-spil. Det i'te laveste kort i en
// farve er sikkert, hvis det er lavt nok i forhold til, hvor mange lavere kort man har.
export function noloDanger(hand) {
  let danger = 0;
  for (const suit of SUITS) {
    const r = ranksIn(hand, suit).map(x => (x === 14 ? 1 : x)).sort((a, b) => a - b); // stigende, esset er 1
    r.forEach((rank, i) => { if (rank > 3 + 2 * i) danger += rank > 9 + 2 * i ? 1 : 0.5; });
  }
  return Math.max(0, danger - 0.5 * jokersIn(hand));
}

// ---------- Beslutninger ----------

const PARTNER_TRICKS = 2.5; // makker-esset + lidt hjælp + katten
const NOLO_EXTRA = { sol: 0, rensol: 1.5, bord: 1, renbord: 2.5 };
const bidKey = b => b.nolo ?? `${b.n}:${b.suffix ?? ''}`;

function chooseBid(s, seat, p) {
  const hand = s.hands[seat];
  const allowed = new Set(allowedBids(s, seat).map(bidKey));
  const wanted = [];
  const best = bestTrump(hand);
  const capacity = trick => Math.min(13, Math.floor(trick + PARTNER_TRICKS + p.margin));
  for (let n = 7; n <= capacity(best.tricks); n++) wanted.push({ n, suffix: null });
  for (let n = 7; n <= capacity(ownTricks(hand, 'C')); n++) wanted.push({ n, suffix: 'gode' });
  for (let n = 7; n <= capacity(ownTricks(hand, 'S')); n++) wanted.push({ n, suffix: 'staerke' });
  for (let n = 7; n <= capacity(ownTricks(hand, null)); n++) wanted.push({ n, suffix: 'trumfloese' });
  for (let n = 7; n <= Math.floor(best.tricks + 0.5 + p.margin); n++) wanted.push({ n, suffix: 'kvarte' });
  const danger = noloDanger(hand);
  for (const key of Object.keys(NOLO_EXTRA)) {
    if (danger <= p.noloSlack - NOLO_EXTRA[key]) wanted.push({ nolo: key });
  }
  const options = wanted.filter(b => allowed.has(bidKey(b))).sort((a, b) => bidRank(a) - bidRank(b));
  return options[0] ?? null; // billigste melding der stadig slår den gældende
}

function chooseAce(hand, trump) {
  const options = ACES.filter(a => suitOf(a) !== trump);
  const others = options.filter(a => !hand.includes(a));
  const byLength = list => list.sort((a, b) => ranksIn(hand, suitOf(b)).length - ranksIn(hand, suitOf(a)).length);
  // Kald esset i den farve, hvor man selv er længst; har man alle esserne, bliver man selvmakker.
  if (others.length) return byLength(others)[0];
  return byLength(options).at(-1);
}

function chooseContract(s, seat) {
  const hand = s.hands[seat], sfx = s.contract.bid.suffix;
  const fixed = { gode: 'C', staerke: 'S', trumfloese: 'NT' }[sfx];
  const trump = sfx == null || sfx === 'kvarte' ? bestTrump(hand).suit : fixed ?? null;
  if (sfx === 'kvarte') return { trump };
  return { trump, ace: chooseAce(hand, trump === 'NT' ? null : trump) };
}

function acceptVip(s, seat, p) {
  const hand = s.hands[seat], card = s.contract.vipCards.at(-1);
  if (isJoker(card)) return ownTricks(hand, null) >= 4;
  return ranksIn(hand, suitOf(card)).length >= p.vipLength;
}

function chooseDiscards(s, seat) {
  const hand = s.hands[seat], c = s.contract;
  if (c.bid.nolo) {
    return [...hand].sort((a, b) => noloValue(b) - noloValue(a)).filter(x => !isJoker(x)).slice(0, 3);
  }
  const trump = trumpSuit(s);
  const keep = card => {
    if (isJoker(card)) return 100;
    if (card === c.ace) return 90;
    const suit = suitOf(card), r = rankOf(card);
    if (suit === trump) return 60 + r;
    if (r === 14) return 50;
    return r + 3 * ranksIn(hand, suit).length; // smid helst fra korte farver for at få renonce
  };
  return [...hand].sort((a, b) => keep(a) - keep(b)).slice(0, 3);
}

// ---------- Stikspil ----------

// Hvem er på hold med hvem, set ud fra hvad spilleren kan vide.
function teamView(s, seat) {
  const c = s.contract, hand = s.hands[seat];
  const known = c.partnerRevealed || (seat === c.declarer && c.selfCall) || (c.ace && hand.includes(c.ace));
  let attackers = null; // melder + makker, når makker kendes
  if (c.bid.nolo || c.bid.suffix === 'kvarte') attackers = [c.declarer];
  else if (known) attackers = [c.declarer, c.partner ?? seat];
  const onAttack = seat === c.declarer || (c.ace && hand.includes(c.ace)) || attackers?.includes(seat);
  return {
    onAttack,
    isMate(other) {
      if (other === seat) return true;
      if (!attackers) return seat === c.declarer || other === c.declarer ? false : null;
      return attackers.includes(other) === onAttack;
    },
  };
}

function seenCards(s, seat) {
  const seen = new Set((s.plays ?? []).map(p => p.card));
  for (const c of s.hands[seat]) seen.add(c);
  if (s.contract.exchanger === seat) for (const c of s.discards) seen.add(c);
  return seen;
}

// Kan kortet ikke slås af noget kort, der stadig er ude? (En joker vinder kun, når den spilles ud.)
function isMaster(s, seat, card) {
  if (isJoker(card)) return !s.trick.length;
  const seen = seenCards(s, seat), suit = suitOf(card);
  for (let r = rankOf(card) + 1; r <= 14; r++) if (!seen.has(suit + r)) return false;
  return true;
}

function winsWith(s, seat, card) {
  return trickWinnerOf([...s.trick, { seat, card }], trumpSuit(s), !!s.contract.bid.nolo) === seat;
}

function playCard(s, seat, p) {
  const legal = legalCards(s, seat);
  if (legal.length === 1) return legal[0];
  if (Math.random() < p.gamble) return pick(legal);
  return s.contract.bid.nolo ? playNolo(s, seat, legal) : playTrump(s, seat, legal);
}

function playTrump(s, seat, legal) {
  const c = s.contract, trump = trumpSuit(s), hand = s.hands[seat];
  const team = teamView(s, seat);
  const sideCards = legal.filter(x => !isJoker(x) && suitOf(x) !== trump);
  const discard = () => lowest(sideCards.length ? sideCards : legal);

  if (!s.trick.length) {
    const masters = legal.filter(x => isMaster(s, seat, x));
    if (team.onAttack && trump) {
      const seen = seenCards(s, seat);
      const trumpsOut = Array.from({ length: 13 }, (_, i) => trump + (i + 2)).some(x => !seen.has(x));
      const masterTrumps = masters.filter(x => !isJoker(x) && suitOf(x) === trump);
      if (trumpsOut && masterTrumps.length) return highest(masterTrumps); // træk trumf
    }
    if (seat === c.declarer && !c.partnerRevealed && c.ace && !hand.includes(c.ace)) {
      const toPartner = legal.filter(x => !isJoker(x) && suitOf(x) === suitOf(c.ace));
      if (toPartner.length) return lowest(toPartner); // spil ud til makker-esset
    }
    const sideMasters = masters.filter(x => !isJoker(x) && suitOf(x) !== trump);
    if (sideMasters.length) return highest(sideMasters);
    const joker = legal.find(isJoker);
    if (joker) return joker; // en joker spillet ud er et sikkert stik
    const bySuit = SUITS.filter(x => x !== trump).map(x => legal.filter(y => !isJoker(y) && suitOf(y) === x)).filter(x => x.length);
    if (!bySuit.length) return lowest(legal);
    bySuit.sort((a, b) => (team.onAttack ? b.length - a.length : a.length - b.length));
    return lowest(bySuit[0]);
  }

  const winner = trickWinnerOf(s.trick, trump);
  const winnerCard = s.trick.find(x => x.seat === winner)?.card;
  const last = s.trick.length === 3;
  const mateWinning = winner != null && team.isMate(winner) === true;
  if (mateWinning && (last || isMaster(s, seat, winnerCard))) return discard();
  const winning = legal.filter(x => winsWith(s, seat, x));
  if (!winning.length) return discard();
  if (last) return lowest(winning);
  const masters = winning.filter(x => isMaster(s, seat, x));
  if (masters.length) return lowest(masters);
  if (mateWinning) return discard();
  return lowest(winning);
}

function playNolo(s, seat, legal) {
  const c = s.contract;
  const low = cards => lowest(cards, noloValue);
  const high = cards => highest(cards, noloValue);
  const losing = legal.filter(x => !winsWith(s, seat, x));
  if (seat === c.declarer) {
    const real = legal.filter(x => !isJoker(x));
    if (!s.trick.length) return low(real.length ? real : legal); // jokerne gemmes til nødstilfælde
    const led = ledSuitOf(s.trick);
    const following = legal.some(x => !isJoker(x) && suitOf(x) === led);
    const safe = losing.filter(x => !isJoker(x));
    if (following) {
      if (safe.length) return high(safe); // den højeste der stadig går under
      const joker = legal.find(isJoker);
      if (joker) return joker;
      return s.trick.length === 3 ? high(legal) : low(legal);
    }
    return high(safe.length ? safe : legal); // renonce: kom af med det farligste
  }
  // Modspillere vil tvinge melderen til at tage stik.
  if (!s.trick.length) return low(legal);
  const declarerPlayed = s.trick.some(x => x.seat === c.declarer);
  if (declarerPlayed && trickWinnerOf(s.trick, null, true) === c.declarer) {
    return high(losing.length ? losing : legal); // lad melderen beholde stikket
  }
  return low(legal);
}

// ---------- Indgang ----------

// Returnerer næste handling for AI-spilleren på `seat`, eller null hvis det ikke er dens tur.
export function decide(s, seat, profileKey) {
  const p = PROFILES[profileKey] ?? PROFILES.normal;
  if (s.turn !== seat) return null;
  switch (s.phase) {
    case 'bidding': return { type: 'bid', bid: chooseBid(s, seat, p) };
    case 'contract': return { type: 'contract', ...chooseContract(s, seat) };
    case 'halveTrump': return { type: 'halveTrump', trump: bestTrump(s.hands[seat], suitOf(s.contract.ace)).suit };
    case 'vip': return { type: 'vip', accept: acceptVip(s, seat, p) };
    case 'exchange':
      return s.contract.tookKat ? { type: 'discard', cards: chooseDiscards(s, seat) } : { type: 'exchange', take: true };
    case 'play': return { type: 'play', card: playCard(s, seat, p) };
    default: return null;
  }
}
