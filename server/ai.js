// AI-spillere. De ser kun deres egen hånd og det, der er offentligt ved bordet
// (meldinger, spillede kort, kendt makker), og træffer valg ud fra simple tommelfingerregler.
import { bidRank, noloDef } from './bids.js';
import {
  ACES, SUITS, allowedBids, canIronHand, canJoin, isJoker, isJokerPlay, ledSuitOf, playSuit, legalCards, rankOf, soloistsOf, suitOf, trickWinnerOf, trumpSuit,
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
    selfCall: 0.5, // kalder eget es (selvmakker, dobbelte point), når sikre stik + dette antal (hjælp fra katten) ≥ meldingen; ca. 3 % af trumfrunderne
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

// Stik man med sikkerhed tager: jokere (spillet ud), topkort i trumf fra esset og nedefter (E, E-K, E-K-D …),
// trumf ud over 5 i længden (modspillerne løber tør for trumf) og esser i sidekulører. Konger osv. i
// sidekulører tæller ikke – de kan blive stukket med trumf.
export function sureTricks(hand, trump) {
  let sure = jokersIn(hand);
  for (const suit of SUITS) {
    const r = ranksIn(hand, suit);
    if (suit !== trump) {
      if (r.includes(14)) sure++;
      continue;
    }
    let top = 0;
    while (r.includes(14 - top)) top++;
    sure += top + Math.max(0, r.length - Math.max(5, top));
  }
  return sure;
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
  // Gå med på en nolo-melding, hvis hånden selv er god nok til den.
  if (canJoin(s, seat) && noloDanger(hand) <= p.noloSlack - NOLO_EXTRA[s.high.bid.nolo]) return { join: true };
  const allowed = new Set(allowedBids(s, seat).map(bidKey));
  const wanted = [];
  const best = bestTrump(hand);
  const capacity = trick => Math.min(13, Math.floor(trick + PARTNER_TRICKS + p.margin));
  // Bliver klør trumf alligevel, meldes "gode" i stedet for en ren melding – det giver dobbelte point.
  const plain = best.suit !== 'C' || !s.rules.bids.gode;
  if (plain) for (let n = 7; n <= capacity(best.tricks); n++) wanted.push({ n, suffix: null });
  for (let n = 7; n <= capacity(ownTricks(hand, 'C')); n++) wanted.push({ n, suffix: 'gode' });
  for (let n = 7; n <= capacity(ownTricks(hand, 'S')); n++) wanted.push({ n, suffix: 'staerke' });
  for (let n = 7; n <= capacity(ownTricks(hand, null)); n++) wanted.push({ n, suffix: 'trumfloese' });
  for (let n = 7; n <= Math.floor(best.tricks + 0.5 + p.margin); n++) wanted.push({ n, suffix: 'kvarte' });
  const danger = noloDanger(hand);
  for (const key of Object.keys(NOLO_EXTRA)) {
    if (danger <= p.noloSlack - NOLO_EXTRA[key]) wanted.push({ nolo: key });
  }
  const options = wanted.filter(b => allowed.has(bidKey(b))).sort((a, b) => bidRank(a) - bidRank(b));
  // Billigste melding der stadig slår den gældende. Uden en melding: kræv nyt spil ved jernhånd.
  return options[0] ?? (canIronHand(s, seat) ? { iron: true } : null);
}

// Fordækt kort: det mindst værdifulde kort uden for trumf (laveste i den korteste kulør).
function chooseCover(s, seat) {
  const hand = s.hands[seat], trump = trumpSuit(s);
  const side = hand.filter(x => !isJoker(x) && suitOf(x) !== trump);
  if (!side.length) return lowest(hand.filter(x => !isJoker(x))) ?? hand[0]; // kun trumf og jokere
  const len = x => side.filter(y => suitOf(y) === suitOf(x)).length;
  return side.sort((a, b) => len(a) - len(b) || rankOf(a) - rankOf(b))[0];
}

// Kulørens vægt: summen af egne kort i kuløren (2–10 som tallet, B=11, D=12, K=13, E=14).
export const suitWeight = (hand, suit) => ranksIn(hand, suit).reduce((a, b) => a + b, 0);

// Kald esset i den kulør, hvor egne kort vejer mest (ved lighed: spar, hjerter, klør, ruder).
// Har man alle esserne uden for trumf, er man tvunget til at være selvmakker – så i den letteste kulør.
// selfCall: kald i stedet sit eget es med vilje (selvmakker giver dobbelte point).
export function chooseAce(hand, trump, selfCall = false) {
  const options = ACES.filter(a => suitOf(a) !== trump);
  const byWeight = list => [...list].sort((a, b) => suitWeight(hand, suitOf(b)) - suitWeight(hand, suitOf(a)));
  const own = options.filter(a => hand.includes(a)), others = options.filter(a => !hand.includes(a));
  if (selfCall && own.length) return byWeight(own)[0];
  if (others.length) return byWeight(others)[0];
  return byWeight(options).at(-1);
}

function chooseContract(s, seat, p) {
  const hand = s.hands[seat], c = s.contract, sfx = c.bid.suffix;
  const fixed = { gode: 'C', staerke: 'S', trumfloese: 'NT' }[sfx];
  const trump = sfx == null || sfx === 'kvarte' ? bestTrump(hand).suit : fixed ?? null;
  if (sfx === 'kvarte') return { trump };
  const plainTrump = trump === 'NT' ? null : trump;
  // Selvmakker med vilje kun når hånden med sikkerhed tager meldingen – Vovehals regner med lidt hjælp fra katten.
  // Ikke ved halve og vip, hvor trumf først bestemmes bagefter.
  const strong = p.selfCall != null && sfx !== 'halve' && sfx !== 'vip' && sureTricks(hand, plainTrump) + p.selfCall >= c.bid.n;
  return { trump, ace: chooseAce(hand, plainTrump, strong) };
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
  const seen = new Set((s.plays ?? []).filter(p => !p.as).map(p => p.card)); // fordækte kort ses ikke
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

// Kulører som spilleren har vist sig at være renonce i (offentlig viden: bekendte ikke kulør).
export function voidSuits(s, seat) {
  const voids = new Set(), plays = s.plays ?? [];
  for (let i = 0; i < plays.length; i += 4) {
    const trick = plays.slice(i, i + 4);
    if (isJokerPlay(trick[0])) continue; // joker spillet ud: ingen kulør at bekende
    const led = playSuit(trick[0]), own = trick.find(p => p.seat === seat);
    if (own && playSuit(own) !== led) voids.add(led);
  }
  return voids;
}

function winsWith(s, seat, card) {
  return trickWinnerOf([...s.trick, { seat, card }], trumpSuit(s), !!s.contract.bid.nolo) === seat;
}

function playCard(s, seat, p) {
  let legal = legalCards(s, seat);
  if (legal.length === 1) return legal[0];
  const covered = seat === s.contract.declarer ? s.contract.covered : null;
  if (covered) {
    // Melderen spiller det fordækte kort ud for at finde makker – ellers gemmes det til kuløren.
    if (!s.trick.length && !s.contract.partnerRevealed) return covered;
    legal = legal.filter(x => x !== covered);
  }
  if (Math.random() < p.gamble) return pick(legal);
  return s.contract.bid.nolo ? playNolo(s, seat, legal) : playTrump(s, seat, legal);
}

// Makker, der har spillet makker-esset, hjælper melderen, når den selv skal spille ud:
// 1) jokere, 2) højeste trumf for at trække trumf – ikke når makker sidder lige foran melderen,
// 3) sikre stik i sidekulørerne (esser, og derefter konge, dame … når de er blevet højest),
// 4) en kulør melderen er renonce i, så melderen kan stikke med trumf.
function leadAsPartner(s, seat, legal) {
  const c = s.contract, trump = trumpSuit(s);
  if (!c.acePlayed || c.partner !== seat || seat === c.declarer) return null;
  const joker = legal.find(isJoker);
  if (joker) return joker;
  const real = legal.filter(x => !isJoker(x));
  if (trump && c.declarer !== (seat + 1) % 4) {
    const trumps = real.filter(x => suitOf(x) === trump);
    const opponents = [0, 1, 2, 3].filter(x => x !== seat && x !== c.declarer);
    const trumpsLeft = !opponents.every(o => voidSuits(s, o).has(trump)); // modspillerne kan stadig have trumf
    if (trumps.length && trumpsLeft) return highest(trumps);
  }
  const masters = real.filter(x => suitOf(x) !== trump && isMaster(s, seat, x));
  if (masters.length) return highest(masters);
  if (trump) {
    const voids = voidSuits(s, c.declarer);
    const ruff = real.filter(x => suitOf(x) !== trump && voids.has(suitOf(x)));
    if (ruff.length && !voids.has(trump)) return lowest(ruff);
  }
  return null;
}

function playTrump(s, seat, legal) {
  const c = s.contract, trump = trumpSuit(s), hand = s.hands[seat];
  const team = teamView(s, seat);
  const sideCards = legal.filter(x => !isJoker(x) && suitOf(x) !== trump);
  const discard = () => lowest(sideCards.length ? sideCards : legal);

  if (!s.trick.length) {
    const forDeclarer = leadAsPartner(s, seat, legal);
    if (forDeclarer) return forDeclarer;
    const masters = legal.filter(x => isMaster(s, seat, x));
    const inFront = c.acePlayed && c.partner === seat && c.declarer === (seat + 1) % 4; // makker lige foran melderen
    if (team.onAttack && trump && !inFront) {
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
  const c = s.contract, max = noloDef(c.bid.nolo).maxTricks;
  // Kun nolo-spillere, der stadig kan gå hjem. En der er gået ned, spiller videre som modspiller og hjælper
  // med at vælte de andre (går én hjem og én ned, betaler taberen vinderen 3 gange grundpoint).
  const soloists = soloistsOf(c).filter(x => s.tricks[x] <= max);
  const low = cards => lowest(cards, noloValue);
  const high = cards => highest(cards, noloValue);
  const losing = legal.filter(x => !winsWith(s, seat, x));
  if (soloists.includes(seat)) {
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
  // Modspillere vil tvinge melderen til at tage stik: spil ud i en kulør, melderen stadig har
  // (ellers smider melderen bare sine farligste kort af).
  if (!s.trick.length) {
    const voids = soloists.map(x => voidSuits(s, x));
    const real = legal.filter(x => !isJoker(x));
    const noneVoid = real.filter(x => voids.every(v => !v.has(suitOf(x))));
    const someHave = real.filter(x => voids.some(v => !v.has(suitOf(x))));
    return low(noneVoid.length ? noneVoid : someHave.length ? someHave : legal);
  }
  const declarerPlayed = s.trick.some(x => soloists.includes(x.seat));
  const winner = trickWinnerOf(s.trick, null, true);
  if (declarerPlayed && soloists.includes(winner)) {
    return high(losing.length ? losing : legal); // lad nolo-spilleren beholde stikket
  }
  // Udspillet bør gå til spilleren lige før melderen: så skal melderen bekende som nummer to
  // uden at kende resten af stikket og må typisk bruge et lavt kort.
  const target = soloists.includes(c.declarer) ? c.declarer : soloists[0];
  const beforeDeclarer = (target + 3) % 4;
  if (declarerPlayed) {
    if (seat === beforeDeclarer) {
      const winning = legal.filter(x => winsWith(s, seat, x));
      if (winning.length) return low(winning); // tag stikket billigst muligt og få udspillet
    } else if (winner === beforeDeclarer && losing.length) {
      return high(losing); // lad spilleren før melderen beholde stikket
    }
  }
  return low(legal);
}

// ---------- Indgang ----------

// Returnerer næste handling for AI-spilleren på `seat`, eller null hvis det ikke er dens tur.
// `profile` er en profilnøgle eller et profilobjekt (bruges i test, fx uden tilfældige fejl).
export function decide(s, seat, profile) {
  const p = typeof profile === 'object' ? profile : PROFILES[profile] ?? PROFILES.normal;
  if (s.turn !== seat) return null;
  switch (s.phase) {
    case 'bidding': return { type: 'bid', bid: chooseBid(s, seat, p) };
    case 'contract': return { type: 'contract', ...chooseContract(s, seat, p) };
    case 'halveTrump': return { type: 'halveTrump', trump: bestTrump(s.hands[seat], suitOf(s.contract.ace)).suit };
    case 'vip': return { type: 'vip', accept: acceptVip(s, seat, p) };
    case 'exchange': {
      if (s.contract.tookKat) return { type: 'discard', cards: chooseDiscards(s, seat) };
      // Den der gik med på nolo, bytter med de kort, melderen lagde – typisk høje kort – så nej tak.
      return { type: 'exchange', take: !(s.contract.exchanges ?? []).some(x => x.took) };
    }
    case 'cover': return { type: 'cover', card: chooseCover(s, seat) };
    case 'play': return { type: 'play', card: playCard(s, seat, p) };
    default: return null;
  }
}
