/* global io */
// Klient: tegner venterum, spillebord, historik og afspiller ud fra den tilstand serveren sender.
const socket = io();
const NAME_KEY = 'whist.name';
const THEME_KEY = 'whist.theme';
const CARD_THEME_KEY = 'whist.cards';

const SUIT_SYM = { S: '♠', H: '♥', C: '♣', D: '♦' };
const SUIT_NAME = { S: 'spar', H: 'hjerter', C: 'klør', D: 'ruder', NT: 'uden trumf' };
const RANK_SYM = { 11: 'B', 12: 'D', 13: 'K', 14: 'E' };
const POS = ['bottom', 'left', 'top', 'right']; // relativt til mig, med uret
const KIND_LABEL = {
  plain: 'Almindelig', vip: 'Vip', halve: 'Halve', staerke: 'Stærke', gode: 'Gode',
  trumfloese: 'Trumfløse', kvarte: 'Kvarte', sol: 'Sol', rensol: 'Ren sol', bord: 'Bordlægger', renbord: 'Ren bordlægger',
};
const STATUS_LABEL = { active: 'i gang', saved: 'gemt', ended: 'afsluttet' };

let state = null;
// Lokale valg der ikke findes på serveren endnu (nulstilles når fasen skifter).
let ui = { key: '', trump: null, ace: null, discard: [] };
let modal = null; // { type: 'standings' | 'html' | 'history' | 'replay', ... }
let nextRoundDeadline = 0;

const storage = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignoreres */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* ignoreres */ } },
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isRed = card => card[0] === 'H' || card[0] === 'D';
const cardText = card => (card[0] === 'J' ? 'Joker' : `${SUIT_SYM[card[0]]}${RANK_SYM[+card.slice(1)] ?? card.slice(1)}`);
const trumpText = t => (t == null ? '–' : t === 'NT' ? 'uden trumf' : `${SUIT_SYM[t]} ${SUIT_NAME[t]}`);
const bidKey = b => b.nolo ?? `${b.n}:${b.suffix ?? ''}`;
const bidText = e => (e.pass ? 'pas' : e.iron ? 'jernhånd' : e.join ? 'går med' : (e.hold ? 'holder ' : '') + esc(e.label));

const FRACTIONS = { 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' };
function fmtPts(n) {
  n = n ?? 0;
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  const abs = Math.abs(n), whole = Math.floor(abs), frac = FRACTIONS[abs - whole];
  if (!frac) return sign + abs.toLocaleString('da-DK', { maximumFractionDigits: 3 });
  return sign + (whole || '') + frac;
}
const toDate = s => new Date(s.replace(' ', 'T') + 'Z');
const fmtDate = s => toDate(s).toLocaleString('da-DK', { dateStyle: 'long', timeStyle: 'short' });
const fmtDay = s => toDate(s).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = s => toDate(s).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
const fmtSec = ms => (ms == null ? '–' : `${(ms / 1000).toLocaleString('da-DK', { maximumFractionDigits: 1 })} sek.`);

// Samme rækkefølge som på serveren: laveste kort først, jokerne yderst til højre.
const SORT_ORDER = { S: 0, H: 1, C: 2, D: 3, J: 4 };
// aceLow: i nolo-spil vises esset først i hver kulør.
const sortCards = (cards, aceLow = false) => {
  const rank = c => (aceLow && c.slice(1) === '14' ? 1 : +c.slice(1));
  return [...cards].sort((a, b) => SORT_ORDER[a[0]] - SORT_ORDER[b[0]] || rank(a) - rank(b));
};

// ---------- Forbindelse ----------

function hello(name) {
  socket.emit('hello', name, res => {
    if (res.ok) {
      storage.set(NAME_KEY, res.data.name);
    } else {
      storage.del(NAME_KEY);
      toast(res.error);
      render();
    }
  });
}

socket.on('connect', () => {
  const name = storage.get(NAME_KEY);
  if (name) hello(name);
});
socket.on('disconnect', () => toast('Forbindelsen blev afbrudt – prøver igen…'));
socket.on('state', s => {
  state = s;
  nextRoundDeadline = s.table?.showResult ? Date.now() + s.table.nextRoundIn : 0;
  render();
});
socket.on('toast', toast);

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

function request(event, ...args) {
  return new Promise(resolve => socket.emit(event, ...args, res => {
    if (!res.ok) toast(res.error);
    resolve(res.ok ? res.data : null);
  }));
}

// Nedtælling til næste runde opdateres uden at tegne hele siden igen.
setInterval(() => {
  const secs = Math.max(0, Math.ceil((nextRoundDeadline - Date.now()) / 1000));
  for (const el of document.querySelectorAll('[data-countdown]')) el.textContent = secs;
}, 250);

// ---------- Tema ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light')) === 'dark';
const themeButton = () => `<button data-action="theme" title="Skift mellem lyst og mørkt tema">${isDark() ? '☀️ Lyst' : '🌙 Mørkt'}</button>`;
darkQuery.addEventListener('change', () => render());

// ---------- Tegning ----------

function render() {
  const app = document.getElementById('app');
  if (!state) return;
  if (replay) {
    renderReplay();
    return renderModal();
  }
  if (!state.me) {
    app.innerHTML = storage.get(NAME_KEY) ? '<p class="connecting">Forbinder…</p>' : nameScreen();
    app.querySelector('input')?.focus();
  } else {
    const t = state.table;
    app.innerHTML = t?.game && t.mySeat >= 0 ? gameScreen(t) : lobbyScreen();
  }
  renderModal();
}

function nameScreen() {
  return `<div class="name-screen"><form id="name-form">
    <h1>♠ Es-makker whist</h1>
    <p>Hvad hedder du?</p>
    <input name="name" maxlength="20" autocomplete="nickname" required>
    <button class="primary" type="submit">Gå ind i venterummet</button>
  </form></div>`;
}

// Titel midt på siden med de fire esser i en vifte til højre.
function titleHtml() {
  const aces = ['S14', 'H14', 'C14', 'D14'].map(c => `<img src="cards/classic/${c}.svg" alt="">`).join('');
  return `<header class="title"><h1>Es-makker whist</h1><div class="title-cards">${aces}</div></header>`;
}

function lobbyScreen() {
  const t = state.table;
  return `${titleHtml()}
  <main class="lobby">
    <section class="box">
      <h2>Online (${state.online.length})</h2>
      <ul class="online">${state.online.map(p => `<li><span class="dot on"></span>${esc(p.name)}${p.atTable ? ' <span class="muted">· ved bordet</span>' : ''}</li>`).join('')}</ul>
    </section>
    <section class="box">${t ? tableBox(t) : noTableBox()}</section>
    <section class="box menu">
      <div class="me">${esc(state.me.name)} <button class="link" data-action="logout">skift navn</button></div>
      <button data-action="history">Historik</button>
      <button data-action="stats">Statistik</button>
      ${themeButton()}
    </section>
  </main>
  ${t?.status === 'countdown' ? `<div class="countdown">${t.countdown}</div>` : ''}`;
}

function noTableBox() {
  const saved = state.saved.map(s => {
    const mine = s.players.some(p => p.id === state.me.id);
    return `<li><div><b>${fmtDate(s.startedAt)}</b><br><span class="muted">${s.players.map(p => esc(p.name)).join(', ')}</span></div>
      <button data-action="resume" data-id="${s.id}" ${mine ? '' : 'disabled title="Du var ikke med ved det bord"'}>Genoptag</button></li>`;
  }).join('');
  return `<h2>Bordet</h2>
    <p>Der er ikke noget bord endnu.</p>
    <div class="actions"><button class="primary" data-action="create">Opret bord</button></div>
    ${saved ? `<h3>Gemte borde</h3><ul class="saved">${saved}</ul>` : ''}`;
}

function tableBox(t) {
  const meId = state.me.id;
  const isOwner = t.ownerId === meId;
  const seated = t.mySeat >= 0 && t.seats[t.mySeat].present;
  const playing = t.status === 'playing' || t.status === 'paused';
  const canJoin = t.reserved ? t.mySeat >= 0 : t.seats.includes(null);
  const ready = seated && t.seats[t.mySeat].ready;
  const canEditBots = seated && t.status === 'waiting' && !t.reserved;

  const seats = t.seats.map((s, i) => {
    if (!s) return '<li class="empty">Ledig plads</li>';
    const remove = s.bot && canEditBots ? `<button class="link" data-action="removeBot" data-seat="${i}" title="Fjern AI-spilleren">✕</button>` : '';
    return `<li class="${s.ready ? 'ready' : ''}">${s.bot ? '<span class="bot">🤖</span>' : `<span class="dot ${s.online && s.present ? 'on' : ''}"></span>`}${esc(s.name)}
      ${s.id === t.ownerId ? '<span class="tag">ejer</span>' : ''}
      <span class="state">${s.ready ? '✔ Klar' : s.present ? 'Ikke klar' : 'Ikke ved bordet'}</span>${remove}</li>`;
  }).join('');

  let actions;
  if (playing) actions = '<p>Spillet er i gang.</p>';
  else if (seated) {
    actions = `<button class="toggle ${ready ? 'on' : ''}" data-action="ready">${ready ? '✔ Klar' : 'Klar'}</button>
      <button data-action="leave">Forlad bordet</button>`;
  } else {
    actions = `<button class="primary" data-action="join" ${canJoin ? '' : 'disabled'}>Sæt dig ved bordet</button>`;
  }
  if (isOwner && !playing) actions += '<button class="danger" data-action="close">Luk bordet</button>';

  const addBots = canEditBots && t.seats.includes(null)
    ? `<div class="add-bots"><b>Tilføj AI-spiller:</b>
        ${state.rulesInfo.aiProfiles.map(p => `<button data-action="addBot" data-profile="${p.key}" title="${esc(p.desc)}">🤖 ${esc(p.label)}</button>`).join('')}
        <ul class="muted">${state.rulesInfo.aiProfiles.map(p => `<li><b>${esc(p.label)}:</b> ${esc(p.desc)}</li>`).join('')}</ul>
      </div>` : '';

  return `<h2>Bordet</h2>
    ${t.reserved ? '<p class="muted">Genoptaget bord – kun spillerne fra sidst kan sætte sig. Spillet fortsætter, hvor I slap.</p>' : ''}
    <ul class="seats">${seats}</ul>
    <div class="actions">${actions}</div>
    ${addBots}
    ${playing ? '' : '<p class="muted">Spillet starter, når alle fire spillere har trykket Klar.</p>'}
    ${rulesBox(t, isOwner && t.status === 'waiting' && !t.reserved)}`;
}

function rulesBox(t, editable) {
  const info = state.rulesInfo;
  const opt = o => `<label class="opt"><input type="checkbox" data-rule="${o.key}" ${t.rules.bids[o.key] ? 'checked' : ''} ${editable ? '' : 'disabled'}>
    <span><b>${esc(o.label)}</b> – ${esc(o.desc)}</span></label>`;
  const order = info.suffixes.filter(s => t.rules.bids[s.key]).map(s => s.label).join(' < ');
  const nolos = info.nolos.filter(x => t.rules.bids[x.key]);
  return `<div class="rules">
    <h3>Regler</h3>
    <p>Es-makker whist med 55 kort (3 jokere) og en kat på 3 kort. Meldingerne 7–13 kan altid meldes.
      ${editable ? 'Som bordets ejer kan du slå påhæng og nolo-meldinger til og fra.' : ''}</p>
    <h4>Påhæng</h4>${info.suffixes.map(opt).join('')}
    <h4>Nolo-meldinger</h4>${info.nolos.map(opt).join('')}
    <h4>Melderunden</h4>
    <label class="opt"><input type="checkbox" data-rule-opt="hold" ${t.rules.hold !== false ? 'checked' : ''} ${editable ? '' : 'disabled'}>
      <span><b>Hold</b> – en spiller tidligere i melderækkefølgen (forhånd først) må melde det samme som en senere spiller
      i stedet for at gå højere. Den senere spiller skal så gå højere eller passe.</span></label>
    <label class="opt"><input type="checkbox" data-rule-opt="jernhaand" ${t.rules.jernhaand !== false ? 'checked' : ''} ${editable ? '' : 'disabled'}>
      <span><b>Jernhånd</b> – en spiller uden billedkort, esser og jokere kan, når det er vedkommendes tur til at melde,
      kræve at der gives kort igen.</span></label>
    <h4>Rangorden</h4>
    <ul>
      <li>Et antal stik med påhæng slår samme antal uden: 8 halve slår 8, men 9 slår 8 med påhæng.</li>
      ${order ? `<li>Påhæng fra lavest til højest: <b>${esc(order)}</b>${t.rules.bids.gode && t.rules.bids.halve ? ' – fx slår gode halve.' : '.'}</li>` : ''}
      ${nolos.map(x => `<li>${esc(x.label)} ligger mellem ${x.level} og ${x.level} med påhæng – den slås af ${x.level}+.</li>`).join('')}
      <li>Melderen kalder et es (ikke i trumf) for at finde sin makker. Kalder man et es, man selv har, er man selvmakker og får dobbelte point.</li>
      <li>En joker spillet ud som første kort vinder altid stikket, og de andre må lægge hvad som helst. Spilles den ikke ud, har den ingen værdi og må kun lægges, når man ikke kan bekende kulør. Jokere kan ikke spilles ud i første stik.</li>
      <li>Man tager enten hele katten og lægger 3 kort, eller beholder sine kort.</li>
    </ul>
    <details><summary>Point</summary>
      <table class="grid">
        <tr><th>Stik</th><th class="num">Uden påhæng</th><th class="num">Med påhæng / vip'1</th><th class="num">Vip'2</th><th class="num">Vip'3</th></tr>
        ${[7, 8, 9, 10, 11, 12, 13].map(n => { const b = 2 ** (n - 10); return `<tr><td>${n}</td>${[1, 2, 4, 8].map(m => `<td class="num">${fmtPts(b * m).replace('+', '')}</td>`).join('')}</tr>`; }).join('')}
      </table>
      <ul>
        <li>Vundet: point × (1 + antal overstik). Tabt: point × antal manglende stik.</li>
        <li>Vip'N = trumf fundet ved det N'te vendte kort. Vendes klør, tæller det dobbelt.</li>
        <li>Selvmakker (meldt til eget es): dobbelte point.</li>
        <li>${info.nolos.map(x => `${esc(x.label)}: ${x.points}`).join(', ')} point fra hver.</li>
        <li>Med makker får/betaler begge makkere pointene. Spiller man alene, betaler hver modspiller, og melderen får det tredobbelte.</li>
      </ul>
    </details>
  </div>`;
}

// ---------- Kort ----------

// Korttemaer. Temaet gælder kun for den enkelte spiller og huskes i browseren.
// classic: klassiske kort (CC0, se public/cards/classic/LICENSE.txt). simple: værdi og kulørtegn.
const CARD_THEMES = ['classic', 'simple'];
const cardTheme = () => {
  const theme = storage.get(CARD_THEME_KEY);
  return CARD_THEMES.includes(theme) ? theme : 'classic';
};

function cardFace(card) {
  if (cardTheme() === 'classic') return `<img src="cards/classic/${card}.svg" alt="${cardText(card)}" draggable="false">`;
  if (card[0] === 'J') return '<span class="r">★</span><span class="s">JOKER</span>';
  return `<span class="r">${RANK_SYM[+card.slice(1)] ?? card.slice(1)}</span><span class="s">${SUIT_SYM[card[0]]}</span><span class="s big">${SUIT_SYM[card[0]]}</span>`;
}

function cardHtml(card, { action, disabled, selected, small, fromKat } = {}) {
  const cls = ['card', cardTheme(), isRed(card) && 'red', card[0] === 'J' && 'joker', small && 'small',
    selected && 'selected', fromKat && 'fromkat'].filter(Boolean).join(' ');
  return action
    ? `<button class="${cls}" data-action="${action}" data-card="${card}" ${disabled ? 'disabled' : ''}>${cardFace(card)}</button>`
    : `<div class="${cls}">${cardFace(card)}</div>`;
}
const backHtml = small => (cardTheme() === 'classic'
  ? `<div class="card classic back ${small ? 'small' : ''}"><img src="cards/classic/back.svg" alt="" draggable="false"></div>`
  : `<div class="card back ${small ? 'small' : ''}"></div>`);
const backs = (n, small) => Array.from({ length: n }, () => backHtml(small)).join('');

// Kulørtegn i rød/sort på en lys plade, så de kan ses i både lyst og mørkt tema.
const suitHtml = s => `<span class="suit ${isRed(s) ? 'red' : 'black'}" title="${SUIT_NAME[s]}">${SUIT_SYM[s]}</span>`;

// Seneste bud fra hver spiller, vist ud for spilleren i midten af bordet.
// Den der skal melde, vises med "…" i stedet for sit forrige bud.
function bidBubbles(bidLog, rel, turn) {
  const latest = {};
  for (const e of bidLog) latest[e.seat] = e;
  if (turn != null) latest[turn] = { seat: turn, thinking: true };
  return Object.values(latest).map(e => `<div class="bubble pos-${rel(e.seat)} ${e.pass ? 'pass' : ''} ${e.thinking ? 'thinking' : ''}">${e.thinking ? '…' : bidText(e)}</div>`).join('');
}

// Den vundne melding i bordets hjørne:
// linje 1 "8 ♣ til ♥" (melding, trumf, makker-es), linje 2 ét felt pr. stik i meldingen,
// der bliver grønt, når melderens side vinder et stik. Makkers stik tæller først med,
// når makker-esset er spillet (`partner` er null indtil da).
function contractCorner(c, tricks, names = null) {
  const nolo = c.nolo ?? !!c.bid?.nolo;
  const pending = '<span class="pending">?</span>';
  let line = esc(c.label);
  if (!nolo) {
    const trump = c.trump == null ? pending : c.trump === 'NT' ? 'sans' : suitHtml(c.trump);
    const target = c.alone ? 'alene' : `til ${c.ace ? suitHtml(c.ace[0]) : pending}`;
    line += ` ${trump} ${target}`;
  }
  let boxes = '';
  if (nolo) {
    // Sol og bordlægger: ét tomt felt (melderen må tage ét stik). Ren sol og ren bordlægger: ingen.
    // Melderens stik: grønt hvis det er tilladt, ellers rødt.
    const def = state.rulesInfo.nolos.find(x => x.key === c.bid?.nolo || x.label === c.label);
    const allowed = def?.maxTricks ?? 0;
    const soloists = c.soloists ?? [c.declarer];
    boxes = soloists.map(seat => {
      const taken = tricks[seat];
      const cells = Array.from({ length: Math.max(allowed, taken) },
        (_, i) => `<span class="stik-box ${i < taken ? (i < allowed ? 'won' : 'lost') : ''}"></span>`).join('');
      const who = soloists.length > 1 && names ? `<span class="who">${esc(names(seat))}</span>` : '';
      return cells || who ? `<div class="stik-boxes" title="${taken} stik – må højst tage ${allowed}">${who}${cells}</div>` : '';
    }).join('');
  } else {
    const goal = c.bid?.n ?? parseInt(c.label, 10);
    const partner = c.partner != null && c.partner !== c.declarer ? tricks[c.partner] : 0;
    const won = tricks[c.declarer] + partner;
    // Modspillernes stik kan kun tælles, når holdene kendes (makker afsløret eller melder alene).
    // Når melderen ikke længere kan nå målet, bliver de yderste grå felter røde – ét pr. stik, der mangler.
    const known = c.alone || c.partner != null;
    const opponents = known ? tricks.reduce((a, b) => a + b, 0) - won : 0;
    const lost = Math.min(goal - Math.min(won, goal), Math.max(0, goal - (13 - opponents)));
    boxes = `<div class="stik-boxes" title="${won} af ${goal} stik">${Array.from({ length: Math.max(goal, won) }, (_, i) => {
      const state = i < won ? 'won' : i >= goal - lost ? 'lost' : '';
      return `<span class="stik-box ${state} ${i >= goal ? 'over' : ''}"></span>`;
    }).join('')}</div>`;
  }
  return `<div class="contract-corner"><div class="big">${line}</div>${boxes}</div>`;
}

// ---------- Spillebordet ----------

function gameScreen(t) {
  const g = t.game, me = t.mySeat;
  const key = `${t.rounds.length}|${g.dealer}|${g.phase}|${g.contract?.tookKat}`;
  if (key !== ui.key) ui = { key, trump: null, ace: null, discard: [] };
  const rel = seat => POS[(seat - me + 4) % 4];
  const isOwner = t.ownerId === state.me.id;
  const anim = trickAnimation(t, g);
  // Vinderens stik tælles først med, når stikket er lagt i bunken.
  const tricks = g.tricks.map((n, seat) => (anim && anim.phase !== 'done' && anim.winner === seat ? n - 1 : n));
  // Visningen af sidste stik lukker af sig selv, når et nyt stik er afgjort.
  const showLast = g.lastCompleted && ui.lastTrick === g.lastCompleted.no && (!anim || anim.phase === 'done');
  const choice = choiceHtml(t, g);

  return `<div class="game">
    <div class="table-area">
      <div class="felt-wrap">
        <div class="felt ${showLast ? 'show-last' : ''}">
          ${[0, 1, 2, 3].map(seat => seatHtml(t, g, seat, rel(seat), tricks, anim)).join('')}
          ${g.contract ? contractCorner(g.contract, tricks, s => t.seats[s].name) : ''}
          <div class="center">${centerHtml(t, g, rel, anim)}</div>
          ${turnHint(t, g, anim)}
          <div class="my-hand">${handHtml(g, me, anim)}</div>
          ${choice ? `<div class="table-choice">${choice}</div>` : ''}
          ${showLast ? lastTrickOverlay(g, rel) : ''}
        </div>
      </div>
      <aside class="side">
        ${g.phase === 'bidding' && g.turn === me ? `<section class="panel">${bidGrid(t, g)}</section>` : ''}
        ${trickPanel(t, g, anim)}
        <div class="round-box">
          <div class="round-head">Runde ${t.rounds.length + (g.phase === 'roundEnd' ? 0 : 1)}</div>
          <div class="round-buttons">
            <button data-action="standings">Stilling</button>
            ${themeButton()}
            ${isOwner ? '<button data-action="save">Gem bordet</button><button class="danger" data-action="end">Afslut spil</button>' : ''}
          </div>
        </div>
      </aside>
    </div>
  </div>
  ${t.status === 'paused' ? pausedOverlay(t, isOwner) : ''}`;
}

const nameAt = seat => esc(state.table.seats[seat]?.name ?? '?');

// Stikbunke: et kort med bagsiden op og antal stik ovenpå. Ligger ved siden af navneboksen.
// Kun bunken med det seneste stik kan åbnes (peek), så man kan se, hvad der blev spillet.
function trickPile(count, bump, peek) {
  if (!count) return '';
  const action = peek ? 'data-action="lastTrick" title="Se sidste stik"' : `title="${count} stik"`;
  return `<div class="pile ${bump ? 'bump' : ''} ${peek ? 'peek' : ''}" ${action}>${backHtml(true)}<span>${count}</span></div>`;
}

// Det seneste stik vist foran hver spiller, mens resten af bordet er sløret. Et tryk lukker.
function lastTrickOverlay(g, rel) {
  const last = g.lastCompleted;
  return `<div class="last-trick" data-action="lastTrick">
    ${last.cards.map(p => `<div class="last-card pos-${rel(p.seat)} ${p.seat === last.winner ? 'winner' : ''}">${cardHtml(p.card)}</div>`).join('')}
    <div class="last-caption">Stik ${last.no} – ${nameAt(last.winner)} tog stikket. Tryk for at lukke.</div>
  </div>`;
}

function seatHtml(t, g, seat, pos, tricks, anim) {
  const p = t.seats[seat], c = g.contract;
  const tags = [];
  if (seat === g.dealer) tags.push('Giver');
  if (c?.declarer === seat) tags.push('Melder');
  if (c?.soloists?.slice(1).includes(seat)) tags.push('Går med');
  if (c && c.partner === seat && c.partner !== c.declarer) tags.push('Makker');
  const peek = g.lastCompleted?.winner === seat && (!anim || anim.phase === 'done');
  const pile = g.phase === 'play' || g.phase === 'roundEnd' ? trickPile(tricks[seat], anim?.bump && anim.winner === seat, peek) : '';
  const openHand = g.openHands?.find(o => o.seat === seat);
  const open = openHand ? `<div class="open-hand">${openHand.cards.map(x => cardHtml(x, { small: true })).join('')}</div>` : '';
  const thinking = g.turn === seat && seat !== t.mySeat && g.phase !== 'bidding' && (!anim || anim.phase === 'done');
  return `<div class="seat-wrap pos-${pos}">
    ${thinking ? '<div class="thinking-dots" title="Det er denne spillers tur"><span></span><span></span><span></span></div>' : ''}
    <div class="seat ${g.turn === seat ? 'turn' : ''} ${p.online ? '' : 'offline'}">
      <div class="name">${p.bot ? '🤖 ' : ''}${esc(p.name)}${p.online ? '' : ' (offline)'}</div>
      ${tags.length ? `<div class="tags">${tags.map(x => `<span class="tag">${x}</span>`).join('')}</div>` : ''}
      <div class="cam" data-seat="${seat}"></div>
      ${open}
    </div>
    ${pile}
  </div>`;
}

// Et færdigt stik afvikles i faser:
//   lift   vinderkortet svæver op (10 % større) og bliver liggende i 2 sek.
//   gather de andre kort flyver hen og lægger sig under vinderkortet
//   flip   bunken vendes med bagsiden op
//   move   bunken glider hen til vinderens stikbunke, der tæller én op (bump)
// Serveren venter tilsvarende, før næste kort spilles ud (se server/index.js).
const TRICK_PHASES = [['lift', 2300], ['gather', 500], ['flip', 400], ['move', 600], ['done', 500]];
let trickAnim = { key: null, start: 0 };

function trickAnimation(t, g) {
  if ((g.phase !== 'play' && g.phase !== 'roundEnd') || g.trick.length || !g.lastTrick) return null;
  const key = `${t.rounds.length}|${g.dealer}|${t.trickWinners.length}`;
  if (trickAnim.key !== key) {
    trickAnim = { key, start: Date.now() };
    let at = 0;
    for (const [, ms] of TRICK_PHASES) {
      at += ms;
      setTimeout(() => { if (trickAnim.key === key) render(); }, at + 20);
    }
  }
  const elapsed = Date.now() - trickAnim.start;
  let phaseStart = 0;
  for (const [phase, ms] of TRICK_PHASES) {
    if (elapsed < phaseStart + ms || phase === 'done') {
      return { phase, winner: g.lastTrick.winner, phaseElapsed: elapsed - phaseStart, bump: phase === 'done' && elapsed < phaseStart + ms };
    }
    phaseStart += ms;
  }
  return null;
}

function centerHtml(t, g, rel, anim) {
  const c = g.contract;
  if (g.phase === 'bidding') return bidBubbles(g.bidLog, rel, g.turn);
  if (g.phase === 'roundEnd' && t.showResult) return resultBox(t, g);
  if (g.phase === 'play' || g.phase === 'roundEnd') {
    if (!anim) return g.trick.map(p => `<div class="played pos-${rel(p.seat)}">${cardHtml(p.card)}</div>`).join('');
    if (anim.phase === 'done') return '';
    // Negativ forsinkelse, så en animation fortsætter, hvor den var, hvis siden tegnes igen undervejs.
    const delay = `style="animation-delay: -${anim.phaseElapsed}ms"`;
    const winnerPos = rel(anim.winner);
    const winnerCard = g.lastTrick.cards.find(p => p.seat === anim.winner).card;
    if (anim.phase === 'lift' || anim.phase === 'gather') {
      return g.lastTrick.cards.map(p => (p.seat === anim.winner
        ? `<div class="played pos-${winnerPos} winner ${anim.phase === 'lift' ? 'lifting' : 'lifted'}" ${anim.phase === 'lift' ? delay : ''}>${cardHtml(p.card)}</div>`
        : `<div class="played pos-${rel(p.seat)} ${anim.phase === 'gather' ? `gather to-${winnerPos}` : ''}" ${anim.phase === 'gather' ? delay : ''}>${cardHtml(p.card)}</div>`)).join('');
    }
    if (anim.phase === 'flip') {
      return `<div class="played pos-${winnerPos} stack"><div class="flipper" ${delay}>
        <div class="face-front">${cardHtml(winnerCard)}</div><div class="face-back">${backHtml(false)}</div></div></div>`;
    }
    return `<div class="played pos-${winnerPos} stack moving to-${winnerPos}" ${delay}>${backHtml(false)}</div>`;
  }
  const flipped = c?.vipCards ?? [];
  const hidden = g.katCount - flipped.length;
  if (g.katCount === 0) return '';
  return `<div class="kat"><div class="cards">${flipped.map(x => cardHtml(x)).join('')}${backs(Math.max(hidden, 0))}</div><div>Katten</div></div>`;
}

function resultBox(t, g) {
  const c = g.contract, r = g.result;
  let who;
  if (c.bid.nolo || c.bid.suffix === 'kvarte') who = 'alene';
  else if (r.solo) who = c.katPartner ? 'alene (makker-esset lå i katten)' : 'som selvmakker';
  else who = `med ${nameAt(r.partner)}`;
  const several = r.soloists?.length > 1;
  const outcome = several
    ? `<p><b>${esc(c.label)}</b> – ${r.soloists.map(x => `${nameAt(x.seat)} ${x.won ? '✔' : '✘'} (${x.tricks} stik)`).join(' · ')}</p>`
    : `<p>${nameAt(c.declarer)} meldte <b>${esc(c.label)}</b> ${who} og fik ${r.teamTricks} stik.</p>`;
  const title = several ? (r.soloists.every(x => x.won) ? '✔ Alle gik hjem!' : r.soloists.some(x => x.won) ? 'Delvist hjem' : '✘ Alle gik ned')
    : r.won ? '✔ Meldingen gik hjem!' : '✘ Meldingen gik ned';
  return `<div class="result-box">
    <h3>${title}</h3>
    ${outcome}
    <table class="pts">${t.seats.map((p, i) => `<tr><td>${esc(p.name)}</td><td class="num ${r.points[i] < 0 ? 'neg' : ''}">${fmtPts(r.points[i])}</td></tr>`).join('')}</table>
    <p class="muted">Næste runde om <b data-countdown>${Math.ceil(t.nextRoundIn / 1000)}</b> sek.</p>
  </div>`;
}

// Panel ved siden af bordet: hvem vandt hvert stik i runden.
// Et stik får en tom linje, når første kort spilles; prikken kommer, når stikket er lagt i vinderens bunke.
function trickPanel(t, g, anim) {
  if (g.phase !== 'play' && g.phase !== 'roundEnd') return '';
  const winners = [...t.trickWinners];
  if (anim && anim.phase !== 'done') winners[winners.length - 1] = null;
  if (g.trick.length) winners.push(null);
  return trickTable(t.seats.map(p => p.name), winners, g.contract);
}

// Stiktabel med en farvet firkant ud for den, der vandt stikket – samme farver som meldingspanelet:
// grøn = melder/makker, rød = modspiller. Indtil makker kendes, er andres stik grå (ellers afsløres makker).
// Nolo: melderens tilladte stik grønt, resten rødt; modspillernes stik grå. `winners` har null for uafgjorte stik.
function trickTable(names, winners, c) {
  const short = name => esc(name.length > 13 ? name.slice(0, 12) + '…' : name);
  const nolo = c.nolo ?? !!c.bid?.nolo;
  const allowed = state.rulesInfo.nolos.find(x => x.key === c.bid?.nolo || x.label === c.label)?.maxTricks ?? 0;
  const soloists = c.soloists ?? [c.declarer];
  const taken = [0, 0, 0, 0];
  const box = w => {
    taken[w]++;
    let cls;
    if (nolo) cls = !soloists.includes(w) ? '' : taken[w] <= allowed ? 'won' : 'lost';
    else if (w === c.declarer) cls = 'won';
    else if (c.partner != null && c.partner !== c.declarer) cls = w === c.partner ? 'won' : 'lost';
    else cls = c.alone || c.partner === c.declarer ? 'lost' : '';
    return `<span class="stik-box ${cls}"></span>`;
  };
  const rows = winners.map((w, i) => `<tr><td>${i + 1}</td>${names.map((_, s) => `<td>${s === w ? box(w) : ''}</td>`).join('')}</tr>`).join('');
  return `<div class="trick-panel">
    <h4>Stik</h4>
    <table>
      <thead><tr><th>#</th>${names.map(n => `<th title="${esc(n)}">${short(n)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// Valg efter meldingen (trumf, makker-es, vip, katten) vises på bordet over spillerens kort.
const CHOICE_PHASES = ['contract', 'halveTrump', 'vip', 'exchange'];

// Instruktion til spilleren lige over egne kort, når det er ens tur (valg efter meldingen har sin egen boks).
function turnHint(t, g, anim) {
  if (g.turn !== t.mySeat || (anim && anim.phase !== 'done')) return '';
  const text = { bidding: 'Din tur til at melde – vælg i panelet til højre', play: 'Din tur – vælg et kort' }[g.phase];
  return text ? `<div class="turn-hint">${text}</div>` : '';
}

// Spillerens eget valg efter meldingen, eller '' hvis det ikke er spillerens tur til at vælge.
function choiceHtml(t, g) {
  const me = t.mySeat, c = g.contract;
  if (!CHOICE_PHASES.includes(g.phase) || g.turn !== me) return '';
  switch (g.phase) {
    case 'contract':
      return contractChooser(g);
    case 'halveTrump': {
      const aceSuit = c.ace[0];
      const intro = c.katPartner
        ? `Makker-esset ${cardText(c.ace)} ligger i katten – du er selvmakker og vælger trumf.`
        : c.declarer === me ? `Du har selv ${cardText(c.ace)} og vælger trumf.` : `Du har ${cardText(c.ace)} og er makker. Vælg trumf.`;
      return `<p>${intro}</p><div class="row">${suitButtons('halveTrump', null, s => s === aceSuit)}</div>`;
    }
    case 'vip': {
      const last = c.vipCards.at(-1);
      const trump = last[0] === 'J' ? 'NT' : last[0];
      return `<p>Vendt: <b>${cardText(last)}</b> (vip'${c.vipFlips})</p>
        <div class="row"><button class="primary" data-action="vip" data-accept="1">Accepter ${trumpText(trump)}</button>
        <button data-action="vip" data-accept="0">Vend næste kort</button></div>`;
    }
    case 'exchange': {
      const before = [...(c.exchanges ?? [])].reverse().find(x => x.took);
      if (!c.tookKat && before) {
        return `<p>${nameAt(before.seat)} har lagt 3 kort. Vil du tage dem? Så skal du bagefter lægge 3 kort.</p>
          <div class="row"><button class="primary" data-action="takeKat">Tag kortene</button><button data-action="keepCards">Behold mine kort</button></div>`;
      }
      if (!c.tookKat) {
        return `<p>Vil du tage katten? Så skal du bagefter lægge 3 kort.</p>
          <div class="row"><button class="primary" data-action="takeKat">Tag katten</button><button data-action="keepCards">Behold mine kort</button></div>`;
      }
      return `<p>Vælg 3 kort at lægge (${ui.discard.length}/3). Kortene fra katten er markeret.</p>
        <div class="row"><button class="primary" data-action="discard" ${ui.discard.length === 3 ? '' : 'disabled'}>Læg kortene</button></div>`;
    }
    default:
      return '';
  }
}

function bidGrid(t, g) {
  const allowed = new Map(g.allowedBids.map(b => [bidKey(b), b]));
  const info = state.rulesInfo;
  const suffixes = info.suffixes.filter(s => t.rules.bids[s.key]);
  const btn = (b, fallback) => {
    // På en nolo-melding går man med ved at trykke på samme melding.
    if (b.nolo && b.nolo === g.joinNolo) {
      return `<button class="primary" data-action="joinBid" title="Spil samme nolo-melding – hver for sig">${esc(fallback)} (går med)</button>`;
    }
    const a = allowed.get(bidKey(b));
    return `<button data-action="bid" data-bid='${esc(JSON.stringify(b))}' ${a ? '' : 'disabled'}>${a?.hold ? 'Hold ' : ''}${esc(a?.label ?? fallback)}</button>`;
  };
  const rows = [];
  for (let n = 7; n <= 13; n++) {
    rows.push(`<div class="bidrow">${btn({ n, suffix: null }, String(n))}${suffixes.map(s => btn({ n, suffix: s.key }, `${n} ${s.label}`)).join('')}</div>`);
  }
  const nolos = info.nolos.filter(x => t.rules.bids[x.key]);
  if (nolos.length) rows.push(`<div class="bidrow">${nolos.map(x => btn({ nolo: x.key }, x.label)).join('')}</div>`);
  const iron = g.canIronHand ? `<button data-action="ironHand" title="Ingen billedkort, esser eller jokere – der gives kort igen">Jernhånd</button>` : '';
  return `<p><b>Din tur til at melde.</b></p>
    <div class="bidgrid">${rows.join('')}</div>
    <div class="row">${iron}<button class="danger" data-action="pass">Pas</button></div>`;
}

function suitButtons(action, selected, isDisabled = () => false) {
  return ['S', 'H', 'C', 'D'].map(s => `<button class="suit-btn ${isRed(s) ? 'red' : ''} ${selected === s ? 'selected' : ''}" data-action="${action}" data-suit="${s}" ${isDisabled(s) ? 'disabled' : ''}>${SUIT_SYM[s]}</button>`).join('');
}

function contractChooser(g) {
  const c = g.contract, sfx = c.bid.suffix;
  const choosesTrump = sfx == null || sfx === 'kvarte';
  const fixed = { gode: 'C', staerke: 'S', trumfloese: 'NT' }[sfx];
  const trump = choosesTrump ? ui.trump : fixed ?? null;
  const needsAce = sfx !== 'kvarte';
  const ready = (!choosesTrump || ui.trump) && (!needsAce || ui.ace);
  let html = `<p>Du fik meldingen <b>${esc(c.label)}</b>.${fixed ? ` Trumf er ${trumpText(fixed)}.` : ''}
    ${sfx === 'halve' ? ' Kald et es – makker vælger trumf.' : ''}${sfx === 'vip' ? ' Kald et es – derefter vippes trumf fra katten.' : ''}</p>`;
  if (choosesTrump) html += `<div class="choice-label">Trumf</div><div class="row">${suitButtons('pickTrump', ui.trump)}</div>`;
  if (needsAce) {
    const aces = ['S', 'H', 'C', 'D'].map(s => {
      const ace = s + '14';
      const blocked = trump && trump !== 'NT' && s === trump;
      return `<button class="suit-btn ${isRed(s) ? 'red' : ''} ${ui.ace === ace ? 'selected' : ''}" data-action="pickAce" data-ace="${ace}" ${blocked ? 'disabled' : ''}>${SUIT_SYM[s]}</button>`;
    }).join('');
    html += `<div class="choice-label">Makker-es</div><div class="row">${aces}</div>`;
    if (ui.ace && g.hand.includes(ui.ace)) html += '<p class="muted">Du har selv esset – du bliver selvmakker og spiller om dobbelte point.</p>';
  }
  return html + `<div class="row"><button class="primary" data-action="confirmContract" ${ready ? '' : 'disabled'}>Bekræft</button></div>`;
}

function handHtml(g, me, anim) {
  const c = g.contract;
  // Man kan ikke spille ud, mens det forrige stik bliver samlet ind.
  if (anim && anim.phase !== 'done') return g.hand.map(x => cardHtml(x)).join('');
  if (g.phase === 'exchange' && g.turn === me && c.tookKat) {
    return sortCards(g.hand, !!c.bid.nolo).map(x => cardHtml(x, { action: 'toggleDiscard', selected: ui.discard.includes(x), fromKat: c.fromKat.includes(x) })).join('');
  }
  if (g.phase === 'play' && g.turn === me) {
    return g.hand.map(x => cardHtml(x, { action: 'play', disabled: !g.legal.includes(x) })).join('');
  }
  return g.hand.map(x => cardHtml(x)).join('');
}

function pausedOverlay(t, isOwner) {
  const missing = t.seats.filter(p => !p.online).map(p => esc(p.name));
  return `<div class="overlay"><div class="box">
    <h2>Spillet er sat på pause</h2>
    <p>Venter på, at ${missing.join(' og ')} kommer tilbage…</p>
    ${isOwner
      ? '<div class="actions" style="justify-content:center"><button class="primary" data-action="save">Gem bordet</button><button class="danger" data-action="end">Afslut spil</button></div>'
      : '<p class="muted">Bordets ejer kan gemme bordet til en anden dag.</p>'}
  </div></div>`;
}

// ---------- Stilling, historik og statistik ----------

// `from` fortæller afspilleren, hvor "Tilbage" skal føre hen.
function standingsTable(players, rounds, from) {
  const totals = Object.fromEntries(players.map(p => [p.id, 0]));
  for (const r of rounds) for (const p of players) totals[p.id] += r.scores[p.id] ?? 0;
  const leader = [...players].sort((a, b) => totals[b.id] - totals[a.id])[0];
  const body = rounds.map(r => `<tr class="${r.won ? '' : 'lost'}">
    <td>${r.roundNo}</td><td>${esc(r.declarer)}</td><td>${esc(r.bidLabel)}</td><td>${esc(r.partner ?? '')}</td>
    <td class="num">${r.teamTricks}</td><td>${r.won ? '✔ hjem' : '✘ ned'}</td>
    ${players.map(p => `<td class="num">${fmtPts(r.scores[p.id])}</td>`).join('')}
    <td>${replayButton(r, from)}</td></tr>`).join('');
  return `${rounds.length && leader ? `<p>Fører: <b>${esc(leader.name)}</b> med ${fmtPts(totals[leader.id])} point.</p>` : ''}
    <table class="grid">
      <thead><tr><th>#</th><th>Melder</th><th>Melding</th><th>Makker</th><th class="num">Stik</th><th>Resultat</th>
        ${players.map(p => `<th class="num">${esc(p.name)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="${7 + players.length}" class="muted">Ingen runder spillet endnu.</td></tr>`}</tbody>
      <tfoot><tr><td colspan="6">Total</td>${players.map(p => `<td class="num">${fmtPts(totals[p.id])}</td>`).join('')}<td></td></tr></tfoot>
    </table>`;
}

const replayButton = (r, from) => (r.hasReplay
  ? `<button class="play-btn" data-action="replay" data-id="${r.id}" data-from="${from}" title="Afspil runden">▶</button>` : '');

function renderModal() {
  const el = document.getElementById('modal');
  if (!modal) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  let html = modal.html;
  if (modal.type === 'standings') {
    const t = state.table;
    if (!t) { modal = null; return renderModal(); }
    const players = t.seats.map(p => ({ id: p.id, name: p.name }));
    html = `<h2>Stillingen</h2>
      <div class="hist-bar"><div class="tabs">${tabButtons(modal.tab ?? 'table')}</div></div>
      ${tabContent(modal.tab, players, t.rounds, 'standings', t.sessionId)}`;
  } else if (modal.type === 'history') {
    html = historyHtml(modal);
  }
  el.innerHTML = `<div class="box ${modal.wide ? 'wide' : ''}"><button class="close" data-action="closeModal">Luk</button>${html}</div>`;
  el.classList.remove('hidden');
}

function setModal(next) {
  modal = next;
  renderModal();
}

const showModal = (html, wide = false) => setModal({ type: 'html', html, wide });

// Historik: åbner direkte på den seneste spilleaften (eller `sessionId`) med fanerne Tabel og Graf.
// Andre aftener vælges i rullelisten øverst.
async function showHistory(sessionId = null, tab = 'table') {
  const list = await request('history:list');
  if (!list) return;
  const id = sessionId ?? list[0]?.id ?? null;
  const detail = id ? await request('history:session', id) : null;
  setModal({ type: 'history', list, detail, tab, wide: true });
}

function historyHtml(m) {
  if (!m.list.length || !m.detail) return '<h2>Historik</h2><p class="muted">Der er ikke spillet nogen runder endnu.</p>';
  const d = m.detail;
  const options = m.list.map(s => `<option value="${s.id}" ${s.id === d.id ? 'selected' : ''}>${fmtDay(s.startedAt)} kl. ${fmtTime(s.startedAt)} · ${s.players.map(p => p.name).join(', ')} · ${s.rounds} ${s.rounds === 1 ? 'runde' : 'runder'}</option>`).join('');
  return `<h2>Historik</h2>
    <div class="hist-bar">
      <div class="tabs">${tabButtons(m.tab)}</div>
      <select data-history-select aria-label="Vælg spilleaften">${options}</select>
    </div>
    ${tabContent(m.tab, d.players, d.rounds, `history:${d.id}`, d.id)}`;
}

// Fanerne – bruges af både historikken og stillingen ved bordet.
const TABS = [['table', 'Runder'], ['chart', 'Pointudvikling'], ['pairs', 'Makkerpar'], ['stats', 'Statistik']];
const tabButtons = active => TABS
  .map(([key, label]) => `<button class="tab ${active === key ? 'active' : ''}" data-action="historyTab" data-tab="${key}">${label}</button>`).join('');

// Indholdet af den valgte fane. Statistikken hentes fra serveren for den ene aften og hentes igen,
// når der er spillet en ny runde.
function tabContent(tab, players, rounds, from, sessionId) {
  if (tab === 'chart') return historyChart(players, rounds);
  if (tab === 'pairs') return pairsChart(players, rounds);
  if (tab === 'stats') {
    if (!sessionId || !rounds.length) return '<p class="muted">Ingen runder spillet endnu.</p>';
    const key = `${sessionId}|${rounds.length}`;
    if (modal.stats?.key === key) return statsHtml(modal.stats.data);
    if (modal.statsLoading !== key) {
      modal.statsLoading = key;
      const current = modal;
      request('stats', sessionId).then(data => {
        if (modal !== current || !data) return;
        modal.stats = { key, data };
        renderModal();
      });
    }
    return '<p class="muted">Henter statistik…</p>';
  }
  return standingsTable(players, rounds, from);
}

// Cirkeldiagram over hvor ofte hvert makkerpar har spillet sammen. Hvert par har en fast farve
// efter pladserne (ikke efter antal), og runder hvor melderen spillede alene, er grå.
function pairsChart(players, rounds) {
  if (!rounds.length) return '<p class="muted">Ingen runder spillet endnu.</p>';
  const slices = [];
  for (let a = 0; a < players.length; a++) {
    for (let b = a + 1; b < players.length; b++) {
      const ids = [players[a].id, players[b].id];
      slices.push({
        label: `${players[a].name} + ${players[b].name}`, color: `var(--series-${slices.length + 1})`,
        count: rounds.filter(r => r.partnerId != null && ids.includes(r.declarerId) && ids.includes(r.partnerId)).length,
      });
    }
  }
  slices.push({ label: 'Alene (selvmakker, kvarte, nolo)', color: 'var(--muted)', count: rounds.filter(r => r.partnerId == null).length });
  const total = rounds.length;
  const cx = 160, cy = 160, ro = 150, ri = 82;
  const point = (r, a) => `${cx + r * Math.sin(a)},${cy - r * Math.cos(a)}`;
  let angle = 0;
  const arcs = slices.filter(s => s.count).map(s => {
    const sweep = (s.count / total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const pct = Math.round((100 * s.count) / total);
    const title = `<title>${esc(s.label)}: ${s.count} ${s.count === 1 ? 'runde' : 'runder'} (${pct} %)</title>`;
    if (s.count === total) {
      return `<g>${title}<circle cx="${cx}" cy="${cy}" r="${(ro + ri) / 2}" fill="none" stroke="${s.color}" stroke-width="${ro - ri}"/></g>`;
    }
    const large = sweep > Math.PI ? 1 : 0;
    return `<path d="M${point(ro, a0)} A${ro},${ro} 0 ${large} 1 ${point(ro, a1)} L${point(ri, a1)} A${ri},${ri} 0 ${large} 0 ${point(ri, a0)} Z" fill="${s.color}" class="slice">${title}</path>`;
  }).join('');
  const legend = slices.map(s => `<tr class="${s.count ? '' : 'none'}"><td><i style="background:${s.color}"></i>${esc(s.label)}</td>
    <td class="num">${s.count}</td><td class="num">${Math.round((100 * s.count) / total)} %</td></tr>`).join('');
  return `<div class="pairs-chart">
    <svg viewBox="0 0 320 320" role="img" aria-label="Fordeling af makkerpar">
      ${arcs}
      <text x="${cx}" y="${cy - 4}" class="donut-total" text-anchor="middle">${total}</text>
      <text x="${cx}" y="${cy + 20}" class="donut-label" text-anchor="middle">${total === 1 ? 'runde' : 'runder'}</text>
    </svg>
    <table class="grid pairs-legend"><thead><tr><th>Makkerpar</th><th class="num">Runder</th><th class="num">Andel</th></tr></thead><tbody>${legend}</tbody></table>
  </div>`;
}

// Point pr. spiller over runderne: x = runde, y = samlet score. Melderen får en udfyldt cirkel,
// makkeren en åben cirkel. Hver spiller har en fast farve efter plads (ikke efter placering).
function historyChart(players, rounds) {
  if (!rounds.length) return '<p class="muted">Ingen runder spillet endnu.</p>';
  const W = 1000, H = 440, L = 56, R = 170, T = 16, B = 40;
  const n = rounds.length;
  const totals = players.map(p => {
    let sum = 0;
    return [0, ...rounds.map(r => (sum += r.scores[p.id] ?? 0))];
  });
  const values = totals.flat();
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 5, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(f => f * mag).find(s => s >= raw);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const x = i => L + (i * (W - L - R)) / n;
  const y = v => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const color = i => `var(--series-${i + 1})`;

  const grid = [];
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${Math.abs(v) < step / 2 ? 'zero' : 'gridline'}"/>
      <text x="${L - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${fmtPts(Math.round(v * 1000) / 1000).replace('+', '')}</text>`);
  }
  const every = Math.ceil(n / 20);
  const xTicks = [];
  for (let i = 0; i <= n; i += every) xTicks.push(`<text x="${x(i)}" y="${H - B + 18}" class="axis" text-anchor="middle">${i}</text>`);

  const lines = players.map((p, pi) => `<path d="${totals[pi].map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')}" class="series-line" stroke="${color(pi)}"/>`).join('');
  const markers = rounds.map((r, ri) => players.map((p, pi) => {
    const cx = x(ri + 1), cy = y(totals[pi][ri + 1]);
    if (p.id === r.declarerId) return `<circle cx="${cx}" cy="${cy}" r="5.5" class="mark-declarer" fill="${color(pi)}"/>`;
    if (p.id === r.partnerId) return `<circle cx="${cx}" cy="${cy}" r="5" class="mark-partner" stroke="${color(pi)}"/>`;
    return '';
  }).join('')).join('');

  // Navn og total for enden af hver linje, skubbet fra hinanden så de ikke overlapper.
  const ends = players.map((p, pi) => ({ pi, y: y(totals[pi][n]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 18);
  const labels = ends.map(({ pi, y: ly }) => `<text x="${x(n) + 10}" y="${ly + 4}" class="end-label"><tspan fill="${color(pi)}">●</tspan> ${esc(players[pi].name)} ${fmtPts(totals[pi][n])}</text>`).join('');

  const hits = rounds.map((r, ri) => `<rect x="${x(ri + 0.5)}" y="${T}" width="${x(1) - x(0)}" height="${H - T - B}" class="hit" data-chart-round="${ri}"/>`).join('');
  const legend = players.map((p, pi) => `<span><i style="background:${color(pi)}"></i>${esc(p.name)}</span>`).join('');

  return `<div class="hist-chart" data-chart='${esc(JSON.stringify({ players: players.map(p => p.name), totals, rounds: rounds.map(r => ({ no: r.roundNo, label: r.bidLabel, declarer: r.declarer, partner: r.partner, won: r.won })) }))}'>
    <div class="chart-legend">${legend}<span class="key"><b>●</b> melder <b>○</b> makker</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Samlet score pr. spiller efter hver runde">
      ${grid.join('')}${xTicks.join('')}
      <text x="${(L + W - R) / 2}" y="${H - 4}" class="axis" text-anchor="middle">Runde</text>
      <line class="crosshair" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      ${lines}${markers}${labels}${hits}
    </svg>
    <div class="chart-tip" hidden></div>
  </div>`;
}

async function showStats() {
  const s = await request('stats');
  if (!s) return;
  showModal(`<h2>Statistik (all time)</h2>${statsHtml(s)}`, true);
}

// Statistiktabellerne i tre kolonner – bruges både for alle aftener og for én aften.
function statsHtml(s) {
  const pct = (won, played) => (played ? `${Math.round((100 * won) / played)} %` : '–');
  // Gennemsnitligt antal stik over (+) eller under (−) målet; ikke for nolo-meldinger.
  const diff = d => (d == null ? '–' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toLocaleString('da-DK', { maximumFractionDigits: 1 })}`);
  const table = (head, rows, cols) => `<table class="grid"><thead><tr>${head}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols}" class="muted">Ingen data endnu.</td></tr>`}</tbody></table>`;
  return `<div class="stats-grid">
      <div class="stats-col">
        <h3>Samlet</h3>
        ${table('<th>Spiller</th><th class="num">Aftener</th><th class="num">Runder</th><th class="num">Point</th>',
          s.totals.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.sessions}</td><td class="num">${r.rounds}</td><td class="num">${fmtPts(r.points)}</td></tr>`).join(''), 4)}
        <h3>Betænkningstid</h3>
        ${table('<th>Spiller</th><th class="num">Gns. melding</th><th class="num">Gns. kort</th><th class="num">Længste kort</th>',
          s.thinking.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmtSec(r.bid_avg)}</td><td class="num">${fmtSec(r.play_avg)}</td><td class="num">${fmtSec(r.play_max)}</td></tr>`).join(''), 4)}
        <h3>Melder og makker</h3>
        ${table('<th>Melder</th><th>Makker</th><th class="num">Spillet</th><th class="num">Vundet</th><th class="num">Vundet %</th>',
          s.pairs.map(r => `<tr><td>${esc(r.declarer)}</td><td>${esc(r.partner)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${pct(r.won, r.played)}</td></tr>`).join(''), 5)}
      </div>
      <div class="stats-col">
        <h3>Som melder</h3>
        ${table('<th>Spiller</th><th>Melding</th><th class="num">Spillet</th><th class="num">Vundet</th><th class="num">Tabt</th><th class="num">Vundet %</th><th class="num" title="Gennemsnitligt antal stik over eller under målet">Over/under</th>',
          s.declarer.map(r => `<tr><td>${esc(r.name)}</td><td>${KIND_LABEL[r.kind] ?? esc(r.kind)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.played - r.won}</td><td class="num">${pct(r.won, r.played)}</td><td class="num">${diff(r.diff)}</td></tr>`).join(''), 7)}
      </div>
      <div class="stats-col">
        <h3>Meldinger</h3>
        <p class="muted">Alle meldinger der er spillet, og hvor ofte de er gået hjem.</p>
        ${table('<th>Melding</th><th class="num">Meldt</th><th class="num">Gået hjem</th><th class="num">Sandsynlighed</th><th class="num" title="Gennemsnitligt antal stik over eller under målet">Over/under</th>',
          s.bids.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${pct(r.won, r.played)}</td><td class="num">${diff(r.diff)}</td></tr>`).join(''), 5)}
      </div>
    </div>`;
}

// ---------- Afspiller ----------
// En runde afspilles på det rigtige bord med betjeningen i højre kolonne.
// Trin 0: kortene er givet. Trin 1…B: ét bud pr. trin. Trin B+1: melding og kat.
// Derefter ét spillet kort pr. trin. Alle trin vises med samme ventetid.

const SPEEDS = [{ label: '>', ms: 2000 }, { label: '>>', ms: 1000 }, { label: '>>>', ms: 400 }];
let replay = null; // { data, from, step, playing, speed, timer, bottom, hidden }

async function openReplay(roundId, from, keep = {}) {
  const data = await request('history:replay', roundId);
  if (!data) return;
  if (replay) clearInterval(replay.timer);
  setModal(null);
  const mine = data.players.findIndex(p => p.id === state.me?.id);
  replay = {
    data, from, step: 0, playing: false, speed: keep.speed ?? 1, timer: null,
    bottom: mine >= 0 ? mine : 0, // egen plads nederst, hvis man var med
    hidden: keep.hidden ?? new Set(),
  };
  document.getElementById('app').innerHTML = '';
  if (keep.autoplay) replayPlay();
  render();
}

function stopReplay() {
  const from = replay?.from ?? '';
  clearInterval(replay?.timer);
  replay = null;
  document.getElementById('app').innerHTML = '';
  render();
  if (from.startsWith('history:')) showHistory(Number(from.slice(8)));
  else if (from === 'standings' && state.table?.game) setModal({ type: 'standings', tab: 'table', wide: true });
}

const contractStep = data => data.bidLog.length + 1;
const replayLastStep = data => contractStep(data) + data.plays.length;

function replayState(data, step) {
  const c = data.contract;
  const hands = data.dealt.hands.map(h => [...h]);
  let kat = [...data.dealt.kat];
  if (step >= contractStep(data)) {
    const exchanges = c.exchanges ?? (c.tookKat ? [{ seat: c.exchanger, took: true, discards: c.discards }] : []);
    for (const ex of exchanges) {
      if (!ex.took) continue;
      hands[ex.seat] = [...hands[ex.seat], ...kat].filter(x => !ex.discards.includes(x));
      kat = ex.discards; // den næste bytter med de kort, der blev lagt
    }
  }
  const count = Math.max(0, step - contractStep(data));
  for (const p of data.plays.slice(0, count)) hands[p.seat] = hands[p.seat].filter(x => x !== p.card);
  const done = Math.floor(count / 4);
  const trickStart = count && count % 4 === 0 ? count - 4 : done * 4;
  const trick = data.plays.slice(trickStart, count);
  const tricks = [0, 0, 0, 0];
  for (const w of data.trickWinners.slice(0, done)) tricks[w]++;
  return { hands, kat, count, done, trick, winner: trick.length === 4 ? data.trickWinners[trickStart / 4] : null, tricks };
}

function replayCaption(data, step, rs) {
  const name = seat => esc(data.players[seat]?.name ?? '?');
  const c = data.contract;
  if (step === 0) return `Kortene er givet. ${name(data.dealer)} er giver, ${name(data.forehand)} er forhånd.`;
  if (step < contractStep(data)) {
    const e = data.bidLog[step - 1];
    if (e.join) return `${name(e.seat)} går med på <b>${esc(e.label)}</b>.`;
    return e.pass ? `${name(e.seat)} melder pas.` : `${name(e.seat)} ${e.hold ? 'holder' : 'melder'} <b>${esc(e.label)}</b>.`;
  }
  if (step === contractStep(data)) {
    const exchanges = c.exchanges ?? [{ seat: c.exchanger, took: c.tookKat, discards: c.discards }];
    const kat = exchanges.map(ex => (ex.took
      ? `${name(ex.seat)} tog ${ex === exchanges[0] ? 'katten' : 'kortene'} og lagde ${ex.discards.map(cardText).join(' ')}.`
      : `${name(ex.seat)} beholdt sine kort.`)).join(' ');
    const vip = c.vipCards.length ? ` Vippede: ${c.vipCards.map(cardText).join(' ')}.` : '';
    return `${name(c.declarer)} fik meldingen <b>${esc(c.label)}</b>.${vip} ${kat}`;
  }
  const last = data.plays[rs.count - 1];
  let text = `${name(last.seat)} spiller ${cardText(last.card)}.`;
  if (rs.winner != null) text += ` ${name(rs.winner)} tager stikket.`;
  if (step === replayLastStep(data)) {
    const r = data.result;
    text += ` <b>${r.won ? 'Meldingen gik hjem' : 'Meldingen gik ned'}</b> med ${r.teamTricks} stik.`;
  }
  return text;
}

// Bordet under afspilning: hver spiller med navneboks, stikbunke og hånd.
// Venstre og højre: kortene lodret med 80 % overlap. Top og bund: vandret som i spillet.
function replayTable(m) {
  const { data, step } = m, c = data.contract, rs = replayState(data, step);
  const rel = seat => POS[(seat - m.bottom + 4) % 4];
  const bidding = step < contractStep(data);
  const acePlayed = data.plays.slice(0, rs.count).some(p => p.card === c.ace);
  const nextSeat = step === 0 ? data.bidLog[0]?.seat
    : bidding ? data.bidLog[step]?.seat ?? null
      : step < replayLastStep(data) ? data.plays[rs.count]?.seat : null;
  const players = data.players.map((p, seat) => {
    const tags = [];
    if (seat === data.dealer) tags.push('Giver');
    if (!bidding && seat === c.declarer) tags.push('Melder');
    if (!bidding && c.soloists?.slice(1).includes(seat)) tags.push('Går med');
    if (!bidding && c.partner != null && seat === c.partner && seat !== c.declarer && acePlayed) tags.push('Makker');
    const cards = m.hidden.has(seat)
      ? backs(rs.hands[seat].length)
      : sortCards(rs.hands[seat], c.nolo && !bidding).map(x => cardHtml(x)).join('');
    return `<div class="rp-player pos-${rel(seat)}">
      <div class="seat-wrap">
        <div class="seat ${nextSeat === seat ? 'turn' : ''}">
          <div class="name">${esc(p.name)}</div>
          ${tags.length ? `<div class="tags">${tags.map(x => `<span class="tag">${x}</span>`).join('')}</div>` : ''}
        </div>
        ${trickPile(rs.tricks[seat])}
      </div>
      <div class="rp-hand">${cards}</div>
    </div>`;
  }).join('');
  let center;
  if (step === 0) center = `<div class="kat"><div class="cards">${rs.kat.map(x => cardHtml(x)).join('')}</div><div>Katten</div></div>`;
  else if (bidding) center = bidBubbles(data.bidLog.slice(0, step), rel, null);
  else if (step === contractStep(data)) {
    center = c.tookKat
      ? `<div class="kat"><div class="cards">${c.discards.map(x => cardHtml(x)).join('')}</div><div>Lagt</div></div>`
      : `<div class="kat"><div class="cards">${rs.kat.map(x => cardHtml(x)).join('')}</div><div>Katten (ikke taget)</div></div>`;
  } else {
    center = rs.trick.map(p => `<div class="played pos-${rel(p.seat)} ${p.seat === rs.winner ? 'winner lifted' : ''}">${cardHtml(p.card)}</div>`).join('');
  }
  const corner = bidding ? '' : contractCorner({
    ...c, alone: c.nolo || !c.ace, partner: acePlayed || step === replayLastStep(data) ? c.partner : null,
  }, rs.tricks, s => data.players[s]?.name ?? '?');
  return `${players}${corner}<div class="center">${center}</div>`;
}

// Stikpanelet under afspilning: alle rundens stik vises fra start (så panelerne under ikke flytter sig),
// og prikken kommer, når stikket er afgjort.
function replayTrickPanel(m, rs) {
  const { data, step } = m, c = data.contract;
  const acePlayed = data.plays.slice(0, rs.count).some(p => p.card === c.ace);
  const winners = data.trickWinners.map((w, i) => (i < rs.done ? w : null));
  return trickTable(data.players.map(p => p.name), winners, {
    ...c, alone: c.nolo || !c.ace, partner: acePlayed || step === replayLastStep(data) ? c.partner : null,
  });
}

// Skelettet bygges én gang; derefter opdateres kun bord, paneler og knappernes tilstand,
// så skyderen kan trækkes uden at blive erstattet undervejs.
function renderReplay() {
  const app = document.getElementById('app'), m = replay, data = m.data, last = replayLastStep(data);
  if (!app.querySelector('#rp-screen')) {
    app.innerHTML = `<div class="game" id="rp-screen">
      <div class="table-area">
        <div class="felt-wrap"><div class="felt" id="rp-table"></div></div>
        <aside class="side">
          <div id="rp-tricks"></div>
          <section class="panel rp-controls">
            <p class="rp-caption" id="rp-caption"></p>
            <div class="row">
              <button data-action="rpStep" data-to="prev" title="Et trin tilbage">◀</button>
              <button class="primary" id="rp-play" data-action="rpToggle"></button>
              <button data-action="rpStep" data-to="next" title="Et trin frem">▶</button>
              <span class="rp-speeds">${SPEEDS.map((s, i) => `<button data-action="rpSpeed" data-speed="${i}" title="${s.ms / 1000} sek. mellem hvert trin">${s.label}</button>`).join('')}</span>
            </div>
            <input type="range" id="rp-slider" min="0" max="${last}" value="0">
            <div class="row">
              <button data-action="rpRound" data-dir="prev" ${data.prevId ? '' : 'disabled'}>← Forrige runde</button>
              <button data-action="rpRound" data-dir="next" ${data.nextId ? '' : 'disabled'}>Næste runde →</button>
            </div>
            <div class="rp-show">Vis kort:
              ${data.players.map((p, seat) => `<label><input type="checkbox" data-rp-hide="${seat}" ${m.hidden.has(seat) ? '' : 'checked'}> ${esc(p.name)}</label>`).join('')}
            </div>
          </section>
          <div class="round-box">
            <div class="round-head">Afspilning · runde ${data.roundNo}</div>
            <div class="round-buttons">
              ${themeButton()}
              <button class="danger" data-action="rpStop">Stop simulering</button>
            </div>
          </div>
        </aside>
      </div>
    </div>`;
  }
  const rs = replayState(data, m.step);
  app.querySelector('#rp-table').innerHTML = replayTable(m);
  app.querySelector('#rp-tricks').innerHTML = replayTrickPanel(m, rs);
  app.querySelector('#rp-caption').innerHTML = replayCaption(data, m.step, rs);
  app.querySelector('#rp-slider').value = m.step;
  app.querySelector('#rp-play').textContent = m.playing ? '⏸ Pause' : '▶ Afspil';
  app.querySelectorAll('[data-action="rpSpeed"]').forEach(b => b.classList.toggle('selected', Number(b.dataset.speed) === m.speed));
}

function replayGoto(step) {
  const last = replayLastStep(replay.data);
  replay.step = Math.max(0, Math.min(last, step));
  if (replay.step === last) replayPause();
  render();
}

function replayPause() {
  clearInterval(replay.timer);
  replay.playing = false;
}

function replayPlay() {
  clearInterval(replay.timer);
  if (replay.step === replayLastStep(replay.data)) replay.step = 0;
  replay.playing = true;
  replay.timer = setInterval(() => replayGoto(replay.step + 1), SPEEDS[replay.speed].ms);
}

// ---------- Handlinger ----------

const actions = {
  theme() {
    const theme = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    storage.set(THEME_KEY, theme);
    if (replay) document.getElementById('app').innerHTML = '';
    render();
  },
  logout() {
    storage.del(NAME_KEY);
    socket.emit('logout');
    state = { ...state, me: null };
    render();
  },
  create: () => socket.emit('table:create'),
  resume: d => socket.emit('table:resume', Number(d.id)),
  join: () => socket.emit('table:join'),
  leave: () => socket.emit('table:leave'),
  close: () => socket.emit('table:end'),
  ready: () => socket.emit('table:ready', !state.table.seats[state.table.mySeat].ready),
  addBot: d => socket.emit('table:addBot', d.profile),
  removeBot: d => socket.emit('table:removeBot', Number(d.seat)),
  save: () => confirm('Gem bordet og send alle tilbage til venterummet?') && socket.emit('table:save'),
  end: () => confirm('Afslut spillet for alle? Stillingen gemmes i historikken.') && socket.emit('table:end'),
  bid: d => socket.emit('game:bid', JSON.parse(d.bid)),
  joinBid: () => socket.emit('game:bid', { join: true }),
  ironHand: () => socket.emit('game:bid', { iron: true }),
  pass: () => socket.emit('game:bid', null),
  pickTrump(d) {
    ui.trump = d.suit;
    if (ui.ace?.[0] === d.suit) ui.ace = null;
    render();
  },
  pickAce(d) {
    ui.ace = d.ace;
    render();
  },
  confirmContract: () => socket.emit('game:contract', { trump: ui.trump, ace: ui.ace }),
  halveTrump: d => socket.emit('game:halveTrump', d.suit),
  vip: d => socket.emit('game:vip', d.accept === '1'),
  takeKat: () => socket.emit('game:exchange', true),
  keepCards: () => socket.emit('game:exchange', false),
  toggleDiscard(d) {
    if (ui.discard.includes(d.card)) ui.discard = ui.discard.filter(x => x !== d.card);
    else if (ui.discard.length < 3) ui.discard.push(d.card);
    render();
  },
  discard: () => socket.emit('game:discard', ui.discard),
  play: d => socket.emit('game:play', d.card),
  standings: () => setModal({ type: 'standings', tab: 'table', wide: true }),
  history: () => showHistory(),
  historyTab(d) {
    modal.tab = d.tab;
    renderModal();
  },
  stats: showStats,
  closeModal: () => setModal(null),
  lastTrick() {
    const no = state.table?.game?.lastCompleted?.no;
    ui.lastTrick = ui.lastTrick === no ? null : no;
    render();
  },
  replay: d => openReplay(Number(d.id), d.from),
  rpStop: stopReplay,
  rpToggle() {
    if (replay.playing) replayPause();
    else replayPlay();
    render();
  },
  rpStep(d) {
    replayPause();
    const to = d.to === 'prev' ? replay.step - 1 : replay.step + 1;
    replayGoto(to);
  },
  rpSpeed(d) {
    replay.speed = Number(d.speed);
    if (replay.playing) replayPlay();
    render();
  },
  rpRound(d) {
    const id = d.dir === 'prev' ? replay.data.prevId : replay.data.nextId;
    if (id) openReplay(id, replay.from, { speed: replay.speed, hidden: replay.hidden, autoplay: true });
  },
};

document.addEventListener('click', e => {
  if (e.target.id === 'modal') return actions.closeModal();
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) actions[el.dataset.action]?.(el.dataset);
});

document.addEventListener('input', e => {
  if (e.target.id !== 'rp-slider') return;
  replayPause();
  replayGoto(Number(e.target.value));
});

// Grafens tooltip: runde, melding og hver spillers samlede score, med en lodret hjælpelinje.
document.addEventListener('mouseover', e => {
  const hit = e.target.closest?.('[data-chart-round]');
  const chart = e.target.closest?.('.hist-chart');
  if (!chart) return;
  const tip = chart.querySelector('.chart-tip'), cross = chart.querySelector('.crosshair');
  if (!hit) {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    return;
  }
  const data = JSON.parse(chart.dataset.chart), i = Number(hit.dataset.chartRound), r = data.rounds[i];
  const cx = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
  cross.setAttribute('x1', cx);
  cross.setAttribute('x2', cx);
  cross.setAttribute('visibility', 'visible');
  const rows = data.players.map((name, pi) => ({ name, pi, v: data.totals[pi][i + 1] })).sort((a, b) => b.v - a.v);
  tip.innerHTML = `<b>Runde ${r.no}</b> · ${esc(r.label)} ${r.won ? '✔' : '✘'}<br>
    <span class="muted">Melder ${esc(r.declarer)}${r.partner && r.partner !== '–' ? `, makker ${esc(r.partner)}` : ''}</span>
    ${rows.map(x => `<div><i style="background:var(--series-${x.pi + 1})"></i>${esc(x.name)} <b>${fmtPts(x.v)}</b></div>`).join('')}`;
  const band = hit.getBoundingClientRect(), box = chart.getBoundingClientRect();
  const px = band.left + band.width / 2 - box.left;
  tip.style.left = `${px + 14 + 220 > box.width ? px - 234 : px + 14}px`;
  tip.style.top = '40px';
  tip.hidden = false;
});

document.addEventListener('change', e => {
  if (e.target.matches?.('[data-history-select]')) return showHistory(Number(e.target.value), modal?.tab ?? 'table');
  const hide = e.target.dataset?.rpHide;
  if (hide != null) {
    if (e.target.checked) replay.hidden.delete(Number(hide));
    else replay.hidden.add(Number(hide));
    return render();
  }
  const { rule, ruleOpt } = e.target.dataset ?? {};
  if (!rule && !ruleOpt) return;
  const rules = structuredClone(state.table.rules);
  if (rule) rules.bids[rule] = e.target.checked;
  else rules[ruleOpt] = e.target.checked;
  socket.emit('table:rules', rules);
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'name-form') return;
  e.preventDefault();
  const name = new FormData(e.target).get('name').trim();
  if (name) hello(name);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modal) actions.closeModal();
});
