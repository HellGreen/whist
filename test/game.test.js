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

test('makker-es og jokere: joker kan ikke spilles ud i første stik, men vinder når den spilles ud', () => {
  const s = fixedRound(3);
  playTo(s, 0, { n: 7, suffix: null }, { trump: 'S', ace: 'H14' });
  G.exchange(s, 0, true);
  assert.equal(s.hands[0].length, 16);
  G.discard(s, 0, ['S2', 'S3', 'S4']); // beholder jokerne
  assert.equal(s.phase, 'play');
  assert.equal(s.contract.partner, 1);
  assert.ok(!G.legalCards(s, 0).some(G.isJoker)); // ikke ud i første stik
  assert.throws(() => G.play(s, 0, 'J1'), /må du ikke/);
  G.play(s, 0, 'S5');
  G.play(s, 1, 'H2');
  G.play(s, 2, 'C2');
  G.play(s, 3, 'D2');
  assert.equal(s.tricks[0], 1);
  // Andet stik: jokeren må gerne spilles ud og vinder, selvom der kommer trumf bagefter.
  G.play(s, 0, 'J1');
  assert.equal(G.legalCards(s, 1).length, 12); // ingen kulør er bestemt endnu
  G.play(s, 1, 'H3');
  s.hands[2].push('S9');
  G.play(s, 2, 'S9'); // trumf, men jokeren spillet ud vinder
  G.play(s, 3, 'D3');
  assert.equal(s.lastTrick.winner, 0);
});

test('jokere: kan man bekende kulør, må man ikke lægge en joker; ellers har den ingen værdi', () => {
  const s = fixedRound(3);
  playTo(s, 0, { n: 7, suffix: null }, { trump: 'C', ace: 'H14' });
  G.exchange(s, 0, false);
  s.hands[1].push('J1');
  s.hands[1].push('S3');
  G.play(s, 0, 'S5');
  assert.deepEqual(G.legalCards(s, 1), ['S3']); // skal bekende spar – jokeren er ikke tilladt
  G.play(s, 1, 'S3');
  s.hands[2].push('J2'); // plads 2 har ingen spar og må derfor lægge jokeren
  assert.ok(G.legalCards(s, 2).includes('J2'));
  G.play(s, 2, 'J2');
  G.play(s, 3, 'D2');
  assert.equal(s.lastTrick.winner, 0); // jokeren har ingen værdi, når den ikke spilles ud
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

test('sol: en joker spillet ud vinder, og de andre må lægge hvad som helst', () => {
  const s = fixedRound(3);
  playTo(s, 0, { nolo: 'sol' });
  assert.equal(s.phase, 'exchange');
  G.exchange(s, 0, true);
  G.discard(s, 0, ['S14', 'S13', 'S12']);
  G.play(s, 0, 'S2');
  G.play(s, 1, 'H2');
  G.play(s, 2, 'C2');
  G.play(s, 3, 'D2');
  assert.equal(s.tricks[0], 1); // melderen tog første stik med spar 2
  G.play(s, 0, 'J1'); // joker ud = sikkert stik, også i sol
  s.hands[2].push('H9');
  G.play(s, 1, 'H3');
  assert.equal(G.legalCards(s, 2).length, s.hands[2].length); // frit valg efter en joker – ingen kulør at bekende
  G.play(s, 2, 'C3');
  G.play(s, 3, 'D3');
  assert.equal(s.lastTrick.winner, 0);
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

test('melderens klient ser ikke makker, før makker-esset er spillet', () => {
  const s = fixedRound(3);
  playTo(s, 0, { n: 7, suffix: null }, { trump: 'S', ace: 'C14' }); // plads 2 har klør es
  G.exchange(s, 0, false);
  assert.equal(G.view(s, 0).contract.partner, null);
  G.play(s, 0, 'S2');
  G.play(s, 1, 'H2');
  G.play(s, 2, 'C14');
  assert.equal(G.view(s, 0).contract.partner, 2); // afsløret i det øjeblik esset spilles
});

test('AI ved nolo: modspillere spiller ikke ud i en kulør, melderen er renonce i', async () => {
  const { decide, voidSuits, PROFILES } = await import('../server/ai.js');
  const flawless = { ...PROFILES.normal, gamble: 0 }; // uden tilfældige fejl, så strategien måles
  const rulesAll = { bids: Object.fromEntries(Object.keys(rules.bids).map(k => [k, true])) };
  let checked = 0;
  for (let i = 0; i < 600; i++) {
    const s = G.newRound(i % 4, rulesAll);
    for (let guard = 0; guard < 200 && !['passed', 'roundEnd'].includes(s.phase); guard++) {
      const seat = s.turn;
      const d = decide(s, seat, flawless);
      const c = s.contract;
      if (d.type === 'play' && c.bid.nolo && G.soloistsOf(c).length === 1 && seat !== c.declarer && !s.trick.length) {
        const voids = voidSuits(s, c.declarer);
        const alternatives = G.legalCards(s, seat).filter(x => !G.isJoker(x) && !voids.has(x[0]));
        if (voids.size && alternatives.length) {
          checked++;
          assert.ok(!voids.has(d.card[0]), `spillede ${d.card} ud, men melderen er renonce i ${[...voids]}`);
        }
      }
      ({ bid: () => G.bid(s, seat, d.bid), contract: () => G.chooseContract(s, seat, d), halveTrump: () => G.halveTrump(s, seat, d.trump),
        vip: () => G.vip(s, seat, d.accept), exchange: () => G.exchange(s, seat, d.take), discard: () => G.discard(s, seat, d.cards),
        play: () => G.play(s, seat, d.card) })[d.type]();
    }
  }
  assert.ok(checked > 0, 'testen ramte ingen relevante situationer');
});

test('AI ved nolo: modspillerne giver udspillet til spilleren lige før melderen', async () => {
  const { decide, PROFILES } = await import('../server/ai.js');
  const flawless = { ...PROFILES.normal, gamble: 0 };
  const rulesAll = { bids: Object.fromEntries(Object.keys(rules.bids).map(k => [k, true])) };
  let grabbed = 0, kept = 0;
  for (let i = 0; i < 600; i++) {
    const s = G.newRound(i % 4, rulesAll);
    for (let guard = 0; guard < 200 && !['passed', 'roundEnd'].includes(s.phase); guard++) {
      const seat = s.turn, d = decide(s, seat, flawless), c = s.contract;
      if (d.type === 'play' && c.bid.nolo && G.soloistsOf(c).length === 1 && seat !== c.declarer && s.trick.some(x => x.seat === c.declarer)) {
        const before = (c.declarer + 3) % 4;
        const winner = G.trickWinnerOf(s.trick, null, true);
        const wins = card => G.trickWinnerOf([...s.trick, { seat, card }], null, true) === seat;
        if (winner !== c.declarer && seat === before && G.legalCards(s, seat).some(wins)) {
          grabbed++;
          assert.ok(wins(d.card), 'spilleren før melderen burde tage stikket');
        }
        if (winner === before && seat !== before && G.legalCards(s, seat).some(x => !wins(x))) {
          kept++;
          assert.ok(!wins(d.card), 'modspilleren burde ikke overtage stikket fra spilleren før melderen');
        }
      }
      ({ bid: () => G.bid(s, seat, d.bid), contract: () => G.chooseContract(s, seat, d), halveTrump: () => G.halveTrump(s, seat, d.trump),
        vip: () => G.vip(s, seat, d.accept), exchange: () => G.exchange(s, seat, d.take), discard: () => G.discard(s, seat, d.cards),
        play: () => G.play(s, seat, d.card) })[d.type]();
    }
  }
  assert.ok(grabbed > 0 && kept > 0, `for få situationer: ${grabbed}/${kept}`);
});

test('gå med: flere spiller sol hver for sig, og katten går videre', async () => {
  const { scoreRound } = await import('../server/scoring.js');
  const s = fixedRound(3); // forhånd = plads 0
  G.bid(s, 0, { nolo: 'sol' });
  assert.throws(() => G.bid(s, 1, { nolo: 'sol' }), /højere/); // sol kan ikke holdes
  assert.ok(G.canJoin(s, 1));
  G.bid(s, 1, { join: true });
  G.bid(s, 2, null);
  G.bid(s, 3, null);
  assert.equal(s.phase, 'exchange');
  assert.deepEqual(s.contract.soloists, [0, 1]);
  assert.equal(s.turn, 0);
  G.exchange(s, 0, true);
  G.discard(s, 0, ['S14', 'S13', 'S12']);
  assert.equal(s.turn, 1); // den der gik med, bytter bagefter – med de kort melderen lagde
  G.exchange(s, 1, true);
  assert.ok(['S14', 'S13', 'S12'].every(x => s.hands[1].includes(x)));
  G.discard(s, 1, ['S14', 'S13', 'S12']);
  assert.equal(s.phase, 'play');

  // Point (sol = 1): begge hjem -> hver modspiller betaler 1 til en vinder.
  const c = { declarer: 0, soloists: [0, 1], bid: { nolo: 'sol' } };
  assert.deepEqual(scoreRound(c, [0, 1, 6, 6]).points, [1, 1, -1, -1]);
  // Én hjem, én ned -> taberen dækker alene vinderens fulde beløb.
  assert.deepEqual(scoreRound(c, [1, 2, 5, 5]).points, [3, -3, 0, 0]);
  // Begge ned -> hver betaler 1 til en modspiller.
  assert.deepEqual(scoreRound(c, [2, 3, 4, 4]).points, [-1, -1, 1, 1]);
  // Én nolo-spiller: almindelig afregning.
  assert.deepEqual(scoreRound({ declarer: 0, bid: { nolo: 'sol' } }, [1, 4, 4, 4]).points, [3, -1, -1, -1]);
});

test('gå med: et overbud nulstiller dem der gik med, og runden slutter først når alle er gået ned', () => {
  const s = fixedRound(3);
  G.bid(s, 0, { nolo: 'sol' });
  G.bid(s, 1, { join: true });
  G.bid(s, 2, { n: 9, suffix: 'gode' }); // overbud
  assert.deepEqual(s.high.joined, []);
  assert.equal(s.turn, 3);
  G.bid(s, 3, null);
  G.bid(s, 0, null);
  G.bid(s, 1, null);
  assert.equal(s.contract.declarer, 2);
  assert.equal(s.contract.soloists, undefined);
});

test('AI kan gå med på nolo, og runder med flere nolo-spillere spilles færdige', async () => {
  const { decide } = await import('../server/ai.js');
  const rulesAll = { bids: Object.fromEntries(Object.keys(rules.bids).map(k => [k, true])) };
  let several = 0;
  for (let i = 0; i < 800; i++) {
    const s = G.newRound(i % 4, rulesAll);
    for (let guard = 0; guard < 300 && !['passed', 'roundEnd'].includes(s.phase); guard++) {
      const seat = s.turn, d = decide(s, seat, 'risky');
      ({ bid: () => G.bid(s, seat, d.bid), contract: () => G.chooseContract(s, seat, d), halveTrump: () => G.halveTrump(s, seat, d.trump),
        vip: () => G.vip(s, seat, d.accept), exchange: () => G.exchange(s, seat, d.take), discard: () => G.discard(s, seat, d.cards),
        play: () => G.play(s, seat, d.card) })[d.type]();
    }
    assert.ok(['passed', 'roundEnd'].includes(s.phase));
    if (s.phase === 'roundEnd' && s.result.soloists?.length > 1) {
      several++;
      assert.equal(s.result.points.reduce((a, b) => a + b), 0); // nulsum
    }
  }
  assert.ok(several > 0, 'ingen AI gik med på nolo');
});

test('AI: makker-es kaldes i kuløren med højest samlet værdi; Vovehals kan vælge selvmakker', async () => {
  const { chooseAce } = await import('../server/ai.js');
  // Hjerter: 2+3+4+5 = 14, klør: K+D = 25 -> klør es, selvom hjerter er længst.
  assert.equal(chooseAce(['H2', 'H3', 'H4', 'H5', 'C13', 'C12', 'S2', 'D3'], null), 'C14');
  // Lige vægt (spar 10 / ruder 10) -> rækkefølgen spar, hjerter, klør, ruder.
  assert.equal(chooseAce(['S10', 'D10', 'H2'], 'H'), 'S14');
  // Trumf kan ikke kaldes.
  assert.equal(chooseAce(['C13', 'C12', 'H2'], 'C'), 'H14');
  // Selvmakker med vilje: eget es i den tungeste kulør.
  assert.equal(chooseAce(['S14', 'S13', 'H14', 'H2', 'D5'], 'D', true), 'S14');
  // Har man alle esser uden for trumf, bliver man selvmakker i den letteste kulør.
  assert.equal(chooseAce(['S14', 'S13', 'H14', 'C14', 'C2'], 'D'), 'H14');
});

test('AI: sikre stik tæller jokere, topkort i trumf, lange trumf og esser i sidekulører', async () => {
  const { sureTricks } = await import('../server/ai.js');
  // Trumf spar E-K-D + 3 små = 6 trumf: 3 topkort + 1 for længden over 5. Hjerter E: 1. Klør K: 0. Joker: 1.
  assert.equal(sureTricks(['S14', 'S13', 'S12', 'S5', 'S4', 'S3', 'H14', 'H2', 'C13', 'J1'], 'S'), 6);
});
