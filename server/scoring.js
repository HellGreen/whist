// Pointberegning, jf. regnskabet på https://da.wikipedia.org/wiki/Whist (es-makker).
// Spillet er et nulsumsspil: summen af point i en runde er altid 0.
import { noloDef } from './bids.js';

// Grundpoint for en melding uden påhæng.
export const BASE = { 7: 1 / 8, 8: 1 / 4, 9: 1 / 2, 10: 1, 11: 2, 12: 4, 13: 8 };

export function basePoints(contract) {
  const { bid } = contract;
  if (bid.nolo) return noloDef(bid.nolo).points;
  let points = BASE[bid.n];
  if (bid.suffix === 'vip') {
    points *= 2 ** contract.vipFlips; // vip'1 = ×2, vip'2 = ×4, vip'3 = ×8
    if (contract.trump === 'C') points *= 2; // klør vendt og valgt som trumf
  } else if (bid.suffix) {
    points *= 2;
  }
  if (contract.selfCall) points *= 2; // meldt til eget es
  return points;
}

// Vundet: grundpoint × (1 + overstik). Tabt: grundpoint × manglende stik.
// Makkerpar: begge får pointene, begge modspillere betaler dem.
// Alene (selvmakker, kvarte, nolo): hver modspiller betaler, melderen får 3×.
export function scoreRound(contract, tricks) {
  const { declarer, partner, bid } = contract;
  const solo = partner == null || partner === declarer;
  const teamTricks = solo ? tricks[declarer] : tricks[declarer] + tricks[partner];
  let points = basePoints(contract);
  let won;
  if (bid.nolo) {
    won = tricks[declarer] <= noloDef(bid.nolo).maxTricks;
  } else {
    const diff = teamTricks - bid.n;
    won = diff >= 0;
    points *= won ? 1 + diff : -diff;
  }
  const sign = won ? 1 : -1;
  const result = [0, 1, 2, 3].map(seat => {
    if (seat === declarer) return sign * points * (solo ? 3 : 1);
    if (!solo && seat === partner) return sign * points;
    return -sign * points;
  });
  return { won, teamTricks, points: result, solo, partner: partner ?? null };
}
