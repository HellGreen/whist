import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bidRank, defaultRules } from '../server/bids.js';
import * as G from '../server/game.js';
import { scoreRound } from '../server/scoring.js';

const rules = defaultRules();

// Usorteret bunke: plads 0 får alle spar, 1 hjerter, 2 klør, 3 ruder; katten er de 3 jokere.
const fixedRound = (dealer = 3) => G.newRound(dealer, rules, G.makeDeck());

test('rangorden: gode slår halve, sol ligger mellem 9 og 9+', () => {
  assert.ok(bidRank({ n: 8, suffix: 'gode' }) > bidRank({ n: 8, suffix: 'halve' }));
  assert.ok(bidRank({ nolo: 'sol' }) > bidRank({ n: 9, suffix: null }));
  assert.ok(bidRank({ nolo: 'sol' }) < bidRank({ n: 9, suffix: 'vip' }));
  assert.ok(bidRank({ nolo: 'rensol' }) > bidRank({ n: 10, suffix: null }));
  assert.ok(bidRank({ nolo: 'rensol' }) < bidRank({ n: 10, suffix: 'vip' }));
  assert.ok(bidRank({ n: 9, suffix: null }) > bidRank({ n: 8, suffix: 'kvarte' }));
});

test('fravalgte meldinger kan ikke meldes', () => {
  const s = fixedRound();
  assert.throws(() => G.bid(s, 0, { n: 7, suffix: 'staerke' }), /Ugyldig/);
});

test('melderunde: forhånd melder, resten passer', () => {
  const s = fixedRound(3); // forhånd = plads 0
  G.bid(s, 0, { n: 7, suffix: null });
  G.bid(s, 1, null);
  G.bid(s, 2, null);
  G.bid(s, 3, null);
  assert.equal(s.phase, 'contract');
  assert.equal(s.contract.declarer, 0);
});

test('melderunde: tidligere spiller kan holde en senere melding', () => {
  const s = fixedRound(3);
  G.bid(s, 0, { n: 7, suffix: null });
  G.bid(s, 1, { n: 8, suffix: null });
  G.bid(s, 2, null);
  G.bid(s, 3, null);
  G.bid(s, 0, { n: 8, suffix: null }); // holder
  assert.equal(s.high.seat, 0);
  assert.equal(s.turn, 1);
  assert.throws(() => G.bid(s, 1, { n: 8, suffix: null }), /højere/);
  G.bid(s, 1, null);
  assert.equal(s.contract.declarer, 0);
});

test('alle passer', () => {
  const s = fixedRound();
  for (const seat of [0, 1, 2, 3]) G.bid(s, seat, null);
  assert.equal(s.phase, 'passed');
});

function playTo(s, declarer, bid, choice) {
  for (let i = 0; i < 4; i++) {
    const seat = (s.forehand + i) % 4;
    G.bid(s, seat, seat === declarer ? bid : null);
  }
  if (choice) G.chooseContract(s, declarer, choice);
}

test('makker-es og stikspil med trumf og joker', () => {
  const s = fixedRound(3);
  playTo(s, 0, { n: 7, suffix: null }, { trump: 'S', ace: 'H14' });
  G.exchange(s, 0, true);
  assert.equal(s.hands[0].length, 16);
  G.discard(s, 0, ['S2', 'S3', 'S4']); // beholder jokerne
  assert.equal(s.phase, 'play');
  assert.equal(s.contract.partner, 1);
  // Plads 0 spiller hjerter? Har ingen – spiller joker. Joker leder = trumf.
  G.play(s, 0, 'J1');
  // Plads 1 har ingen spar/joker -> alle kort er lovlige
  assert.equal(G.legalCards(s, 1).length, 13);
  G.play(s, 1, 'H2');
  G.play(s, 2, 'C2');
  G.play(s, 3, 'D2');
  assert.equal(s.tricks[0], 1);
  assert.equal(s.turn, 0);
});

test('esmakker skal spille esset, når kuløren spilles ud', () => {
  const s = fixedRound(0); // forhånd = plads 1 (hjerter)
  playTo(s, 1, { n: 7, suffix: null }, { trump: 'H', ace: 'C14' });
  G.exchange(s, 1, false);
  assert.equal(s.contract.partner, 2);
  G.play(s, 1, 'H2');
  G.play(s, 2, 'C2'); // har ikke hjerter
  G.play(s, 3, 'D2');
  G.play(s, 0, 'S2');
  // stikket går til plads 1 (trumf). Klør spilles ud – men plads 1 har ingen klør.
  assert.equal(s.turn, 1);
  s.hands[1].push('C3');
  G.play(s, 1, 'C3');
  assert.deepEqual(G.legalCards(s, 2), ['C14']);
});

test('sol uden trumf: joker vinder aldrig', () => {
  const s = fixedRound(3);
  playTo(s, 0, { nolo: 'sol' });
  assert.equal(s.phase, 'exchange');
  G.exchange(s, 0, true);
  G.discard(s, 0, ['S14', 'S13', 'S12']);
  G.play(s, 0, 'J1');
  G.play(s, 1, 'H2');
  G.play(s, 2, 'C2');
  G.play(s, 3, 'D2');
  assert.equal(s.tricks[1], 1); // første rigtige kort satte kuløren
});

test('point: 9 vip\'2 med 10 stik giver 4 til hver i makkerparret', () => {
  const contract = { declarer: 0, partner: 2, bid: { n: 9, suffix: 'vip' }, vipFlips: 2, trump: 'H', selfCall: false };
  const r = scoreRound(contract, [6, 1, 4, 2]);
  assert.equal(r.won, true);
  assert.deepEqual(r.points, [4, -4, 4, -4]);
});

test('point: selvmakker giver dobbelt, modspillerne betaler hver', () => {
  const contract = { declarer: 0, partner: 0, bid: { n: 8, suffix: null }, trump: 'S', selfCall: true };
  const r = scoreRound(contract, [8, 2, 2, 1]);
  assert.deepEqual(r.points, [1.5, -0.5, -0.5, -0.5]);
});

test('point: tabt melding', () => {
  const contract = { declarer: 0, partner: 1, bid: { n: 10, suffix: 'gode' }, trump: 'C', selfCall: false };
  const r = scoreRound(contract, [4, 4, 3, 2]); // 8 stik, 2 for lidt
  assert.equal(r.won, false);
  assert.deepEqual(r.points, [-4, -4, 4, 4]);
});

test('afspilning: uddelte kort, kat og alle spillede kort gemmes', () => {
  const s = fixedRound(3);
  playTo(s, 0, { n: 7, suffix: null }, { trump: 'S', ace: 'H14' });
  G.exchange(s, 0, true);
  G.discard(s, 0, ['S2', 'S3', 'S4']);
  while (s.phase === 'play') G.play(s, s.turn, G.legalCards(s, s.turn)[0]);
  const r = G.replayOf(s);
  assert.equal(r.dealt.hands[0].length, 13);
  assert.deepEqual(r.dealt.kat, ['J1', 'J2', 'J3']);
  assert.deepEqual(r.contract.discards, ['S2', 'S3', 'S4']);
  assert.equal(r.plays.length, 52);
  assert.equal(r.trickWinners.length, 13);
  assert.equal(r.result.won, true);
});

test('AI: fire AI-spillere kan spille mange runder uden fejl', async () => {
  const { decide, PROFILES } = await import('../server/ai.js');
  const profiles = Object.keys(PROFILES);
  const rulesAll = { bids: Object.fromEntries(Object.keys(rules.bids).map(k => [k, true])) };
  const kinds = {};
  let played = 0;
  for (let i = 0; i < 400; i++) {
    const s = G.newRound(i % 4, i % 2 ? rules : rulesAll);
    for (let guard = 0; guard < 200 && !['passed', 'roundEnd'].includes(s.phase); guard++) {
      const seat = s.turn;
      const d = decide(s, seat, profiles[seat % 3]);
      if (d.type === 'bid') G.bid(s, seat, d.bid);
      else if (d.type === 'contract') G.chooseContract(s, seat, d);
      else if (d.type === 'halveTrump') G.halveTrump(s, seat, d.trump);
      else if (d.type === 'vip') G.vip(s, seat, d.accept);
      else if (d.type === 'exchange') G.exchange(s, seat, d.take);
      else if (d.type === 'discard') G.discard(s, seat, d.cards);
      else if (d.type === 'play') G.play(s, seat, d.card);
    }
    assert.ok(['passed', 'roundEnd'].includes(s.phase), `runde ${i} gik i stå i ${s.phase}`);
    if (s.phase === 'roundEnd') {
      played++;
      const k = s.contract.label.replace(/^\d+ ?/, '') || 'almindelig';
      kinds[k] ??= [0, 0];
      kinds[k][s.result.won ? 0 : 1]++;
    }
  }
  console.log('AI-runder spillet:', played, 'af 400 · [vundet, tabt] pr. meldingstype:', JSON.stringify(kinds));
  assert.ok(played > 100);
});

test('melderunde: uden reglen "hold" skal man altid melde højere', () => {
  const s = G.newRound(3, { ...rules, hold: false }, G.makeDeck());
  G.bid(s, 0, { n: 7, suffix: null });
  G.bid(s, 1, { n: 8, suffix: null });
  G.bid(s, 2, null);
  G.bid(s, 3, null);
  assert.throws(() => G.bid(s, 0, { n: 8, suffix: null }), /højere/);
  assert.ok(G.allowedBids(s, 0).every(b => !b.hold));
});

test('visning: i nolo-spil står esset først i hver kulør', () => {
  assert.equal(G.sortCards(['S14', 'S2', 'H14', 'H9', 'J1']).join(' '), 'S2 S14 H9 H14 J1');
  assert.equal(G.sortCards(['S14', 'S2', 'H14', 'H9', 'J1'], true).join(' '), 'S14 S2 H14 H9 J1');
  const s = fixedRound(3);
  playTo(s, 0, { nolo: 'sol' });
  assert.equal(G.view(s, 0).hand[0], 'S14');
});

test('nolo: esset tæller som 1', () => {
  const s = fixedRound(3); // plads 0 har alle spar
  playTo(s, 0, { nolo: 'sol' });
  G.exchange(s, 0, false);
  s.hands[1].push('S5'); // plads 1 får en spar, så den skal bekende
  G.play(s, 0, 'S14');
  G.play(s, 1, 'S5');
  G.play(s, 2, 'C2');
  G.play(s, 3, 'D2');
  assert.equal(s.lastTrick.winner, 1); // spar 5 slår esset
  assert.equal(G.trickWinnerOf([{ seat: 0, card: 'S14' }, { seat: 1, card: 'S5' }], null), 0); // men ikke uden for nolo
});
