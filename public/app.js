/* global io */
// Klient: tegner venterum, spillebord, historik og afspiller ud fra den tilstand serveren sender.
const socket = io();
const NAME_KEY = 'whist.name';

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
const animatedContracts = new Set(); // meldinger der allerede er gledet ud i hjørnet

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
const bidText = e => (e.pass ? 'pas' : (e.hold ? 'holder ' : '') + esc(e.label));

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

const SORT_ORDER = { J: 0, S: 1, H: 2, C: 3, D: 4 };
const sortCards = cards => [...cards].sort((a, b) => SORT_ORDER[a[0]] - SORT_ORDER[b[0]] || +b.slice(1) - +a.slice(1));

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

// ---------- Tegning ----------

function render() {
  const app = document.getElementById('app');
  if (!state) return;
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

function header() {
  return `<header class="top">
    <h1>♠ ♥ Es-makker whist ♣ ♦</h1>
    <nav>
      <button data-action="history">Historik</button>
      <button data-action="stats">Statistik</button>
      <span class="me">${esc(state.me.name)}</span>
      <button class="link" data-action="logout">skift navn</button>
    </nav>
  </header>`;
}

function lobbyScreen() {
  const t = state.table;
  return `${header()}
  <main class="lobby">
    <section class="box">
      <h2>Online (${state.online.length})</h2>
      <ul class="online">${state.online.map(p => `<li><span class="dot on"></span>${esc(p.name)}${p.atTable ? ' <span class="muted">· ved bordet</span>' : ''}</li>`).join('')}</ul>
    </section>
    <section class="box">${t ? tableBox(t) : noTableBox()}</section>
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
    <h4>Rangorden</h4>
    <ul>
      <li>Et antal stik med påhæng slår samme antal uden: 8 halve slår 8, men 9 slår 8 med påhæng.</li>
      ${order ? `<li>Påhæng fra lavest til højest: <b>${esc(order)}</b>${t.rules.bids.gode && t.rules.bids.halve ? ' – fx slår gode halve.' : '.'}</li>` : ''}
      ${nolos.map(x => `<li>${esc(x.label)} ligger mellem ${x.level} og ${x.level} med påhæng – den slås af ${x.level}+.</li>`).join('')}
      <li>En spiller tidligere i melderunden må <i>holde</i> (melde det samme som) en senere spillers melding.</li>
      <li>Melderen kalder et es (ikke i trumf) for at finde sin makker. Kalder man et es, man selv har, er man selvmakker og får dobbelte point.</li>
      <li>Jokerne er de højeste trumfer (den første joker i et stik vinder). Uden trumf kan en joker altid spilles, men den vinder aldrig.</li>
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

function cardHtml(card, { action, disabled, selected, small, fromKat } = {}) {
  const joker = card[0] === 'J';
  const face = joker
    ? '<span class="r">★</span><span class="s">JOKER</span>'
    : `<span class="r">${RANK_SYM[+card.slice(1)] ?? card.slice(1)}</span><span class="s">${SUIT_SYM[card[0]]}</span><span class="s big">${SUIT_SYM[card[0]]}</span>`;
  const cls = ['card', isRed(card) && 'red', joker && 'joker', small && 'small', selected && 'selected', fromKat && 'fromkat'].filter(Boolean).join(' ');
  return action
    ? `<button class="${cls}" data-action="${action}" data-card="${card}" ${disabled ? 'disabled' : ''}>${face}</button>`
    : `<div class="${cls}">${face}</div>`;
}
const backs = (n, small) => Array.from({ length: n }, () => `<div class="card back ${small ? 'small' : ''}"></div>`).join('');

// Seneste bud fra hver spiller, vist ud for spilleren i midten af bordet.
// Den der skal melde, vises med "…" i stedet for sit forrige bud.
function bidBubbles(bidLog, rel, turn) {
  const latest = {};
  for (const e of bidLog) latest[e.seat] = e;
  if (turn != null) latest[turn] = { seat: turn, thinking: true };
  return Object.values(latest).map(e => `<div class="bubble pos-${rel(e.seat)} ${e.pass ? 'pass' : ''} ${e.thinking ? 'thinking' : ''}">${e.thinking ? '…' : bidText(e)}</div>`).join('');
}

// Den vundne melding i bordets hjørne.
function contractCorner(c, names, animateKey) {
  const enter = animateKey && !animatedContracts.has(animateKey);
  if (enter) animatedContracts.add(animateKey);
  const rows = [`<div class="big">${esc(c.label)}</div>`, `<div>${esc(names(c.declarer))}</div>`];
  rows.push(`<div>Trumf: <b>${c.trump ? trumpText(c.trump) : 'ikke bestemt'}</b></div>`);
  if (c.ace) rows.push(`<div>Makker-es: <b>${cardText(c.ace)}</b></div>`);
  if (c.partner != null) rows.push(`<div>Makker: <b>${c.partner === c.declarer ? 'selvmakker' : esc(names(c.partner))}</b></div>`);
  return `<div class="contract-corner ${enter ? 'enter' : ''}">${rows.join('')}</div>`;
}

// ---------- Spillebordet ----------

function gameScreen(t) {
  const g = t.game, me = t.mySeat;
  const key = `${t.rounds.length}|${g.dealer}|${g.phase}|${g.contract?.tookKat}`;
  if (key !== ui.key) ui = { key, trump: null, ace: null, discard: [] };
  const rel = seat => POS[(seat - me + 4) % 4];
  const isOwner = t.ownerId === state.me.id;
  const roundKey = `${t.rounds.length}|${g.dealer}|${t.seats.map(s => s.id).join()}`;

  return `<div class="game">
    <header class="top">
      <div>Runde ${t.rounds.length + (g.phase === 'roundEnd' ? 0 : 1)} · Giver: <b>${nameAt(g.dealer)}</b></div>
      <nav>
        <button data-action="standings">Stilling</button>
        <button data-action="history">Historik</button>
        ${isOwner ? '<button data-action="save">Gem bordet</button><button class="danger" data-action="end">Afslut spil</button>' : ''}
      </nav>
    </header>
    <div class="table-area">
      <div class="felt-wrap">
        <div class="felt">
          ${[0, 1, 2, 3].map(seat => seatHtml(t, g, seat, rel(seat))).join('')}
          ${g.contract ? contractCorner(g.contract, s => t.seats[s].name, roundKey) : ''}
          <div class="center">${centerHtml(t, g, rel)}</div>
        </div>
      </div>
      <aside class="side">
        <section class="panel">${panelHtml(t, g)}</section>
        ${trickPanel(t, g)}
      </aside>
    </div>
    <section class="hand">${handHtml(g, me)}</section>
  </div>
  ${t.status === 'paused' ? pausedOverlay(t, isOwner) : ''}`;
}

const nameAt = seat => esc(state.table.seats[seat]?.name ?? '?');

function seatHtml(t, g, seat, pos) {
  const p = t.seats[seat], c = g.contract;
  const tags = [];
  if (seat === g.dealer) tags.push('Giver');
  if (c?.declarer === seat) tags.push('Melder');
  if (c && c.partner === seat && c.partner !== c.declarer) tags.push('Makker');
  const info = g.phase === 'play' || g.phase === 'roundEnd' ? `${g.tricks[seat]} stik` : '';
  const open = g.openHand?.seat === seat
    ? `<div class="open-hand">${g.openHand.cards.map(x => cardHtml(x, { small: true })).join('')}</div>` : '';
  return `<div class="seat pos-${pos} ${g.turn === seat ? 'turn' : ''} ${p.online ? '' : 'offline'}">
    <div class="name">${p.bot ? '🤖 ' : ''}${esc(p.name)}${p.online ? '' : ' (offline)'}${tags.map(x => `<span class="tag">${x}</span>`).join('')}</div>
    <div class="cam" data-seat="${seat}"></div>
    ${info ? `<div class="info">${info}</div>` : ''}
    ${open}
  </div>`;
}

function centerHtml(t, g, rel) {
  const c = g.contract;
  if (g.phase === 'bidding') return bidBubbles(g.bidLog, rel, g.turn);
  if (g.phase === 'roundEnd' && t.showResult) return resultBox(t, g);
  if (g.phase === 'play' || g.phase === 'roundEnd') {
    const cards = g.trick.length ? g.trick : g.lastTrick?.cards ?? [];
    const winner = g.trick.length ? null : g.lastTrick?.winner;
    return cards.map(p => `<div class="played pos-${rel(p.seat)} ${p.seat === winner ? 'winner' : ''}">${cardHtml(p.card)}</div>`).join('');
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
  return `<div class="result-box">
    <h3>${r.won ? '✔ Meldingen gik hjem!' : '✘ Meldingen gik ned'}</h3>
    <p>${nameAt(c.declarer)} meldte <b>${esc(c.label)}</b> ${who} og fik ${r.teamTricks} stik.</p>
    <table class="pts">${t.seats.map((p, i) => `<tr><td>${esc(p.name)}</td><td class="num ${r.points[i] < 0 ? 'neg' : ''}">${fmtPts(r.points[i])}</td></tr>`).join('')}</table>
    <p class="muted">Næste runde om <b data-countdown>${Math.ceil(t.nextRoundIn / 1000)}</b> sek.</p>
    <button class="danger" data-action="stop">Stop spillet</button>
  </div>`;
}

// Panel ved siden af bordet: hvem vandt hvert stik i runden.
function trickPanel(t, g) {
  if (g.phase !== 'play' && g.phase !== 'roundEnd') return '';
  const short = name => esc(name.length > 8 ? name.slice(0, 7) + '…' : name);
  const rows = t.trickWinners.map((w, i) => `<tr><td>${i + 1}</td>${t.seats.map((_, s) => `<td>${s === w ? '●' : ''}</td>`).join('')}</tr>`).join('');
  const c = g.contract;
  const goal = c.bid.nolo ? `Melderen må højst få ${c.bid.nolo.startsWith('ren') ? 0 : 1} stik` : `Mål: ${c.bid.n} stik`;
  return `<div class="trick-panel">
    <h4>Stik</h4>
    <table>
      <thead><tr><th>#</th>${t.seats.map(p => `<th title="${esc(p.name)}">${short(p.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Σ</td>${g.tricks.map(n => `<td>${n}</td>`).join('')}</tr></tfoot>
    </table>
    <p class="muted">${goal}</p>
  </div>`;
}

function panelHtml(t, g) {
  const me = t.mySeat, c = g.contract, myTurn = g.turn === me;
  const waiting = what => `<p class="muted">Venter på, at ${nameAt(g.turn)} ${what}…</p>`;

  switch (g.phase) {
    case 'bidding':
      return myTurn ? bidGrid(t, g) : waiting('melder');
    case 'contract':
      return myTurn ? contractChooser(g) : waiting('vælger trumf og makker-es');
    case 'halveTrump': {
      if (!myTurn) return waiting('vælger trumf');
      const aceSuit = c.ace[0];
      const intro = c.katPartner
        ? `Makker-esset ${cardText(c.ace)} ligger i katten – du er selvmakker og vælger trumf.`
        : c.declarer === me ? `Du har selv ${cardText(c.ace)} og vælger trumf.` : `Du har ${cardText(c.ace)} og er makker. Vælg trumf.`;
      return `<p>${intro}</p><div class="row">${suitButtons('halveTrump', null, s => s === aceSuit)}</div>`;
    }
    case 'vip': {
      if (!myTurn) return waiting('vipper');
      const last = c.vipCards.at(-1);
      const trump = last[0] === 'J' ? 'NT' : last[0];
      return `<p>Vendt: <b>${cardText(last)}</b> (vip'${c.vipFlips})</p>
        <div class="row"><button class="primary" data-action="vip" data-accept="1">Accepter ${trumpText(trump)}</button>
        <button data-action="vip" data-accept="0">Vend næste kort</button></div>`;
    }
    case 'exchange': {
      if (!myTurn) return waiting('bytter med katten');
      if (!c.tookKat) {
        return `<p>Vil du tage katten? Så skal du bagefter lægge 3 kort.</p>
          <div class="row"><button class="primary" data-action="takeKat">Tag katten</button><button data-action="keepCards">Behold mine kort</button></div>`;
      }
      return `<p>Vælg 3 kort at lægge (${ui.discard.length}/3). Kortene fra katten er markeret.</p>
        <div class="row"><button class="primary" data-action="discard" ${ui.discard.length === 3 ? '' : 'disabled'}>Læg kortene</button></div>`;
    }
    case 'play':
      return myTurn ? '<p><b>Din tur</b> – vælg et kort.</p>' : waiting('spiller');
    case 'roundEnd':
      return t.showResult ? '<p class="muted">Scoren vises på bordet.</p>' : '<p class="muted">Runden er slut…</p>';
    default:
      return '';
  }
}

function bidGrid(t, g) {
  const allowed = new Map(g.allowedBids.map(b => [bidKey(b), b]));
  const info = state.rulesInfo;
  const suffixes = info.suffixes.filter(s => t.rules.bids[s.key]);
  const btn = (b, fallback) => {
    const a = allowed.get(bidKey(b));
    return `<button data-action="bid" data-bid='${esc(JSON.stringify(b))}' ${a ? '' : 'disabled'}>${a?.hold ? 'Hold ' : ''}${esc(a?.label ?? fallback)}</button>`;
  };
  const rows = [];
  for (let n = 7; n <= 13; n++) {
    rows.push(`<div class="bidrow">${btn({ n, suffix: null }, String(n))}${suffixes.map(s => btn({ n, suffix: s.key }, `${n} ${s.label}`)).join('')}</div>`);
  }
  const nolos = info.nolos.filter(x => t.rules.bids[x.key]);
  if (nolos.length) rows.push(`<div class="bidrow">${nolos.map(x => btn({ nolo: x.key }, x.label)).join('')}</div>`);
  return `<p><b>Din tur til at melde.</b></p>
    <div class="bidgrid">${rows.join('')}</div>
    <div class="row"><button class="danger" data-action="pass">Pas</button></div>`;
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
  if (choosesTrump) html += `<div class="row">Trumf: ${suitButtons('pickTrump', ui.trump)}</div>`;
  if (needsAce) {
    const aces = ['S', 'H', 'C', 'D'].map(s => {
      const ace = s + '14';
      const blocked = trump && trump !== 'NT' && s === trump;
      return `<button class="suit-btn ${isRed(s) ? 'red' : ''} ${ui.ace === ace ? 'selected' : ''}" data-action="pickAce" data-ace="${ace}" ${blocked ? 'disabled' : ''}>E${SUIT_SYM[s]}</button>`;
    }).join('');
    html += `<div class="row">Makker-es: ${aces}</div>`;
    if (ui.ace && g.hand.includes(ui.ace)) html += '<p class="muted">Du har selv esset – du bliver selvmakker og spiller om dobbelte point.</p>';
  }
  return html + `<div class="row"><button class="primary" data-action="confirmContract" ${ready ? '' : 'disabled'}>Bekræft</button></div>`;
}

function handHtml(g, me) {
  const c = g.contract;
  if (g.phase === 'exchange' && g.turn === me && c.tookKat) {
    return sortCards(g.hand).map(x => cardHtml(x, { action: 'toggleDiscard', selected: ui.discard.includes(x), fromKat: c.fromKat.includes(x) })).join('');
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
  if (modal?.type === 'replay') return renderReplay(el);
  if (!modal) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  let html = modal.html;
  if (modal.type === 'standings') {
    const t = state.table;
    if (!t) { modal = null; return renderModal(); }
    html = `<h2>Stillingen</h2>${standingsTable(t.seats.map(p => ({ id: p.id, name: p.name })), t.rounds, 'standings')}`;
  } else if (modal.type === 'history') {
    html = historyHtml(modal);
  }
  el.innerHTML = `<div class="box"><button class="close" data-action="closeModal">Luk</button>${html}</div>`;
  el.classList.remove('hidden');
}

function setModal(next) {
  if (modal?.type === 'replay') clearInterval(modal.timer);
  modal = next;
  renderModal();
}

const showModal = html => setModal({ type: 'html', html });

// Historik: spilleaftener efter dato og klokkeslæt; vælges én, vises dens runder nedenunder.
async function showHistory(openId = null) {
  const list = await request('history:list');
  if (!list) return;
  setModal({ type: 'history', list, openId: null, detail: null });
  if (openId) await toggleHistorySession(openId);
}

async function toggleHistorySession(id) {
  if (modal?.type !== 'history') return;
  if (modal.openId === id) {
    modal.openId = null;
    return renderModal();
  }
  const detail = await request('history:session', id);
  if (!detail || modal?.type !== 'history') return;
  modal.openId = id;
  modal.detail = detail;
  renderModal();
}

function historyHtml(m) {
  if (!m.list.length) return '<h2>Historik</h2><p class="muted">Der er ikke spillet nogen runder endnu.</p>';
  const items = m.list.map(s => {
    const ranked = [...s.players].sort((a, b) => (s.totals[b.id] ?? 0) - (s.totals[a.id] ?? 0));
    const open = m.openId === s.id;
    let body = '';
    if (open) {
      const d = m.detail;
      const rows = d.rounds.map(r => `<tr class="${r.won ? '' : 'lost'}">
        <td>${r.roundNo}</td><td>${esc(r.bidLabel)}</td><td>${esc(r.declarer)}</td><td>${esc(r.partner ?? '')}</td>
        <td class="result">${r.won ? '✔' : '✘'}</td><td>${replayButton(r, `history:${s.id}`)}</td></tr>`).join('');
      body = `<div class="session-body">
        ${rows ? `<table class="grid rounds"><thead><tr><th>#</th><th>Melding</th><th>Melder</th><th>Makker</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="muted">Ingen runder spillet.</p>'}
        <button data-action="historySession" data-id="${s.id}">Vis fuld stilling</button>
      </div>`;
    }
    return `<li class="${open ? 'open' : ''}">
      <button class="session-head" data-action="historyToggle" data-id="${s.id}">
        <span class="when"><b>${fmtDay(s.startedAt)}</b> kl. ${fmtTime(s.startedAt)}</span>
        <span class="who">${ranked.map(p => `${esc(p.name)} ${fmtPts(s.totals[p.id])}`).join(' · ')}</span>
        <span class="muted">${s.rounds} ${s.rounds === 1 ? 'runde' : 'runder'} · ${STATUS_LABEL[s.status] ?? s.status}</span>
      </button>${body}</li>`;
  }).join('');
  return `<h2>Historik</h2><p class="muted">Vælg en spilleaften for at se runderne. Tryk ▶ for at afspille en runde.</p>
    <ul class="sessions">${items}</ul>`;
}

async function showSession(id) {
  const s = await request('history:session', id);
  if (!s) return;
  showModal(`<button data-action="historyBack" data-id="${s.id}">← Tilbage</button>
    <h2>Spilleaften ${fmtDate(s.startedAt)}</h2>${standingsTable(s.players, s.rounds, `history:${s.id}`)}`);
}

async function showStats() {
  const s = await request('stats');
  if (!s) return;
  const pct = (won, played) => (played ? `${Math.round((100 * won) / played)} %` : '–');
  showModal(`<h2>Statistik (all time)</h2>
    <h3>Samlet</h3>
    <table class="grid"><thead><tr><th>Spiller</th><th class="num">Aftener</th><th class="num">Runder</th><th class="num">Point</th></tr></thead>
      <tbody>${s.totals.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.sessions}</td><td class="num">${r.rounds}</td><td class="num">${fmtPts(r.points)}</td></tr>`).join('')}</tbody></table>
    <h3>Som melder</h3>
    <table class="grid"><thead><tr><th>Spiller</th><th>Melding</th><th class="num">Spillet</th><th class="num">Vundet</th><th class="num">Tabt</th><th class="num">Vundet %</th></tr></thead>
      <tbody>${s.declarer.map(r => `<tr><td>${esc(r.name)}</td><td>${KIND_LABEL[r.kind] ?? esc(r.kind)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.played - r.won}</td><td class="num">${pct(r.won, r.played)}</td></tr>`).join('')}</tbody></table>
    <h3>Melder og makker</h3>
    <table class="grid"><thead><tr><th>Melder</th><th>Makker</th><th class="num">Spillet</th><th class="num">Vundet</th><th class="num">Vundet %</th></tr></thead>
      <tbody>${s.pairs.map(r => `<tr><td>${esc(r.declarer)}</td><td>${esc(r.partner)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${pct(r.won, r.played)}</td></tr>`).join('')}</tbody></table>
    <h3>Betænkningstid</h3>
    <table class="grid"><thead><tr><th>Spiller</th><th class="num">Gns. pr. melding</th><th class="num">Gns. pr. kort</th><th class="num">Længste kort</th></tr></thead>
      <tbody>${s.thinking.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmtSec(r.bid_avg)}</td><td class="num">${fmtSec(r.play_avg)}</td><td class="num">${fmtSec(r.play_max)}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">Ingen data endnu.</td></tr>'}</tbody></table>`);
}

// ---------- Afspiller ----------
// Trin 0: kortene er givet. Trin 1…B: ét bud pr. trin. Trin B+1: melding og kat.
// Derefter ét spillet kort pr. trin. Alle trin vises med samme ventetid.

const SPEEDS = [{ label: '>', ms: 2000 }, { label: '>>', ms: 1000 }, { label: '>>>', ms: 400 }];

async function openReplay(roundId, from) {
  const data = await request('history:replay', roundId);
  if (!data) return;
  const mine = data.players.findIndex(p => p.id === state.me?.id);
  setModal({
    type: 'replay', data, from, step: 0, playing: false, speed: 1, timer: null,
    bottom: mine >= 0 ? mine : 0, // egen plads nederst, hvis man var med
    hidden: new Set(),
  });
}

const contractStep = data => data.bidLog.length + 1;
const replayLastStep = data => contractStep(data) + data.plays.length;

function replayState(data, step) {
  const c = data.contract;
  const hands = data.dealt.hands.map(h => [...h]);
  let kat = [...data.dealt.kat];
  if (step >= contractStep(data) && c.tookKat) {
    hands[c.exchanger] = [...hands[c.exchanger], ...kat].filter(x => !c.discards.includes(x));
    kat = [];
  }
  const count = Math.max(0, step - contractStep(data));
  for (const p of data.plays.slice(0, count)) hands[p.seat] = hands[p.seat].filter(x => x !== p.card);
  const done = Math.floor(count / 4);
  const trickStart = count && count % 4 === 0 ? count - 4 : done * 4;
  const trick = data.plays.slice(trickStart, count);
  const tricks = [0, 0, 0, 0];
  for (const w of data.trickWinners.slice(0, done)) tricks[w]++;
  return { hands, kat, count, trick, winner: trick.length === 4 ? data.trickWinners[trickStart / 4] : null, tricks };
}

function replayCaption(data, step, rs) {
  const name = seat => esc(data.players[seat]?.name ?? '?');
  const c = data.contract;
  if (step === 0) return `Kortene er givet. ${name(data.dealer)} er giver, ${name(data.forehand)} er forhånd.`;
  if (step < contractStep(data)) {
    const e = data.bidLog[step - 1];
    return e.pass ? `${name(e.seat)} melder pas.` : `${name(e.seat)} ${e.hold ? 'holder' : 'melder'} <b>${esc(e.label)}</b>.`;
  }
  if (step === contractStep(data)) {
    const kat = c.tookKat
      ? `${name(c.exchanger)} tog katten og lagde ${c.discards.map(cardText).join(' ')}.`
      : `${name(c.exchanger)} beholdt sine kort.`;
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

function replayView(m) {
  const { data, step } = m, c = data.contract, rs = replayState(data, step);
  const rel = seat => POS[(seat - m.bottom + 4) % 4];
  const bidding = step < contractStep(data);
  const nextSeat = step === 0 ? data.bidLog[0]?.seat
    : bidding ? data.bidLog[step]?.seat ?? null
      : step < replayLastStep(data) ? data.plays[rs.count]?.seat : null;
  const seats = data.players.map((p, seat) => {
    const tags = [];
    if (seat === data.dealer) tags.push('Giver');
    if (!bidding && seat === c.declarer) tags.push('Melder');
    if (!bidding && c.partner != null && seat === c.partner && seat !== c.declarer) tags.push('Makker');
    const hand = m.hidden.has(seat)
      ? backs(rs.hands[seat].length, true)
      : sortCards(rs.hands[seat]).map(x => cardHtml(x, { small: true })).join('');
    return `<div class="seat pos-${rel(seat)} ${nextSeat === seat ? 'turn' : ''}">
      <div class="name">${esc(p.name)}${tags.map(x => `<span class="tag">${x}</span>`).join('')}</div>
      ${step > contractStep(data) ? `<div class="info">${rs.tricks[seat]} stik</div>` : ''}
      <div class="rp-hand">${hand}</div>
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
    center = rs.trick.map(p => `<div class="played pos-${rel(p.seat)} ${p.seat === rs.winner ? 'winner' : ''}">${cardHtml(p.card)}</div>`).join('');
  }
  const corner = bidding ? '' : contractCorner(c, s => data.players[s]?.name ?? '?', null);
  return `<div class="felt rp-felt">${seats}${corner}<div class="center">${center}</div></div>
    <p class="rp-caption">${replayCaption(data, step, rs)}</p>`;
}

function renderReplay(el) {
  const m = modal, last = replayLastStep(m.data);
  if (!el.querySelector('#rp-view')) {
    el.innerHTML = `<div class="box replay">
      <button class="close" data-action="closeModal">Luk</button>
      <button data-action="rpBack">← Tilbage</button>
      <h2>Afspilning af runde ${m.data.roundNo}</h2>
      <div id="rp-view"></div>
      <div class="rp-controls">
        <div class="row">
          <button data-action="rpStep" data-to="first" title="Til start">⏮</button>
          <button data-action="rpStep" data-to="prev" title="Et trin tilbage">◀</button>
          <button class="primary" id="rp-play" data-action="rpToggle"></button>
          <button data-action="rpStep" data-to="next" title="Et trin frem">▶</button>
          <button data-action="rpStep" data-to="last" title="Til slut">⏭</button>
          <span class="rp-speeds">${SPEEDS.map((s, i) => `<button data-action="rpSpeed" data-speed="${i}" title="${s.ms / 1000} sek. mellem hvert trin">${s.label}</button>`).join('')}</span>
        </div>
        <input type="range" id="rp-slider" min="0" max="${last}" value="0">
        <div class="row">Vis kort: ${m.data.players.map((p, seat) => `<label><input type="checkbox" data-rp-hide="${seat}" ${m.hidden.has(seat) ? '' : 'checked'}> ${esc(p.name)}</label>`).join('')}</div>
      </div>
    </div>`;
    el.classList.remove('hidden');
  }
  el.querySelector('#rp-view').innerHTML = replayView(m);
  el.querySelector('#rp-slider').value = m.step;
  el.querySelector('#rp-play').textContent = m.playing ? '⏸ Pause' : '▶ Afspil';
  el.querySelectorAll('[data-action="rpSpeed"]').forEach(b => b.classList.toggle('selected', Number(b.dataset.speed) === m.speed));
}

function replayGoto(step) {
  const last = replayLastStep(modal.data);
  modal.step = Math.max(0, Math.min(last, step));
  if (modal.step === last) replayPause();
  renderModal();
}

function replayPause() {
  clearInterval(modal.timer);
  modal.playing = false;
}

function replayPlay() {
  clearInterval(modal.timer);
  if (modal.step === replayLastStep(modal.data)) modal.step = 0;
  modal.playing = true;
  modal.timer = setInterval(() => replayGoto(modal.step + 1), SPEEDS[modal.speed].ms);
}

// ---------- Handlinger ----------

const actions = {
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
  stop: () => confirm('Stop spillet for alle? Stillingen gemmes i historikken.') && socket.emit('table:stop'),
  bid: d => socket.emit('game:bid', JSON.parse(d.bid)),
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
  standings: () => setModal({ type: 'standings' }),
  history: () => showHistory(),
  historyToggle: d => toggleHistorySession(Number(d.id)),
  historySession: d => showSession(Number(d.id)),
  historyBack: d => showHistory(Number(d.id)),
  stats: showStats,
  closeModal: () => setModal(null),
  replay: d => openReplay(Number(d.id), d.from),
  rpBack() {
    const from = modal.from ?? '';
    if (from.startsWith('history:')) showHistory(Number(from.slice(8)));
    else setModal({ type: 'standings' });
  },
  rpToggle() {
    if (modal.playing) replayPause();
    else replayPlay();
    renderModal();
  },
  rpStep(d) {
    replayPause();
    const to = { first: 0, prev: modal.step - 1, next: modal.step + 1, last: replayLastStep(modal.data) }[d.to];
    replayGoto(to);
  },
  rpSpeed(d) {
    modal.speed = Number(d.speed);
    if (modal.playing) replayPlay();
    renderModal();
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

document.addEventListener('change', e => {
  const hide = e.target.dataset?.rpHide;
  if (hide != null) {
    if (e.target.checked) modal.hidden.delete(Number(hide));
    else modal.hidden.add(Number(hide));
    return renderModal();
  }
  const key = e.target.dataset?.rule;
  if (!key) return;
  const rules = structuredClone(state.table.rules);
  rules.bids[key] = e.target.checked;
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
