// Meldinger i es-makker whist: definitioner, rangorden og visningsnavne.
import { UserError } from './errors.js';

// Påhæng, sorteret fra lavest til højest inden for samme antal stik.
export const SUFFIXES = [
  {
    key: 'vip', label: 'vip', default: true,
    desc: 'Melderen kalder et es, hvorefter kortene i katten vendes ét ad gangen, indtil melderen accepterer trumffarven (det tredje kort gælder altid). Vendes en joker, spilles der uden trumf.',
  },
  {
    key: 'halve', label: 'halve', default: true,
    desc: 'Melderen kalder et es. Makker (den der har esset) bestemmer trumf (ikke essets kulør) og må bytte med katten. Ligger esset i katten, er melderen selvmakker.',
  },
  { key: 'staerke', label: 'stærke', default: false, desc: 'Spar er trumf.' },
  { key: 'gode', label: 'gode', default: true, desc: 'Klør er trumf.' },
  { key: 'trumfloese', label: 'trumfløse', default: false, desc: 'Der spilles uden trumf.' },
  { key: 'kvarte', label: 'kvarte', default: false, desc: 'Melderen spiller alene uden makker og vælger selv trumf.' },
];

// Nolo-meldinger: solospil uden trumf. Rangerer mellem `level` og `level` med påhæng.
export const NOLOS = [
  { key: 'sol', label: 'Sol', level: 9, maxTricks: 1, points: 1, open: false, default: true,
    desc: 'Melderen spiller alene uden trumf og må højst tage ét stik.' },
  { key: 'rensol', label: 'Ren sol', level: 10, maxTricks: 0, points: 2, open: false, default: true,
    desc: 'Som sol, men melderen må ikke tage nogen stik.' },
  { key: 'bord', label: 'Bordlægger', level: 11, maxTricks: 1, points: 4, open: true, default: true,
    desc: 'Som sol, men melderens kort lægges åbent efter første udspil.' },
  { key: 'renbord', label: 'Ren bordlægger', level: 12, maxTricks: 0, points: 8, open: true, default: true,
    desc: 'Som ren sol, men melderens kort lægges åbent efter første udspil.' },
];

export const noloDef = key => NOLOS.find(x => x.key === key);
const suffixIndex = key => SUFFIXES.findIndex(x => x.key === key);

// hold: en spiller tidligere i melderækkefølgen må melde det samme som en senere spiller.
// jernhaand: en spiller uden billedkort, esser og jokere kan kræve, at der gives om.
const OPTIONS = { hold: true, jernhaand: true };

export function defaultRules() {
  return { bids: Object.fromEntries([...SUFFIXES, ...NOLOS].map(o => [o.key, o.default])), ...OPTIONS };
}

export function sanitizeRules(raw) {
  const rules = defaultRules();
  for (const key of Object.keys(rules.bids)) {
    if (typeof raw?.bids?.[key] === 'boolean') rules.bids[key] = raw.bids[key];
  }
  for (const key of Object.keys(OPTIONS)) {
    if (typeof raw?.[key] === 'boolean') rules[key] = raw[key];
  }
  return rules;
}

// Talværdi til sammenligning: n < nolo på niveau n < n med påhæng (stigende) < n+1.
export function bidRank(bid) {
  if (bid.nolo) return noloDef(bid.nolo).level * 20 + 5;
  return bid.n * 20 + (bid.suffix ? 10 + suffixIndex(bid.suffix) : 0);
}

export function bidLabel(bid) {
  if (bid.nolo) return noloDef(bid.nolo).label;
  return bid.suffix ? `${bid.n} ${SUFFIXES[suffixIndex(bid.suffix)].label}` : String(bid.n);
}

export function allBids(rules) {
  const bids = [];
  for (let n = 7; n <= 13; n++) {
    bids.push({ n, suffix: null });
    for (const s of SUFFIXES) if (rules.bids[s.key]) bids.push({ n, suffix: s.key });
  }
  for (const x of NOLOS) if (rules.bids[x.key]) bids.push({ nolo: x.key });
  return bids.sort((a, b) => bidRank(a) - bidRank(b));
}

export function parseBid(raw, rules) {
  const invalid = () => { throw new UserError('Ugyldig melding'); };
  if (raw?.nolo) {
    if (!noloDef(raw.nolo) || !rules.bids[raw.nolo]) invalid();
    return { nolo: raw.nolo };
  }
  const n = raw?.n, suffix = raw?.suffix ?? null;
  if (!Number.isInteger(n) || n < 7 || n > 13) invalid();
  if (suffix !== null && (suffixIndex(suffix) < 0 || !rules.bids[suffix])) invalid();
  return { n, suffix };
}

export function rulesInfo() {
  const strip = ({ key, label, desc }) => ({ key, label, desc });
  return {
    suffixes: SUFFIXES.map(strip),
    nolos: NOLOS.map(x => ({ ...strip(x), level: x.level, points: x.points, maxTricks: x.maxTricks })),
  };
}
