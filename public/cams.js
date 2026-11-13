// Webcam og lyd ved bordet: WebRTC direkte mellem spillernes browsere (kun STUN, ingen TURN).
// Serveren formidler kun opsætningen (rtc:signal). Kolonnen #cams ligger uden for #app, så
// videoerne ikke rives ned, når bordet tegnes forfra.
//
// Forhandling efter "perfect negotiation"-mønstret: begge sider må sende et tilbud; ved sammenstød
// giver den "høflige" side (højeste spiller-id) efter. Hver sideindlæsning har sit eget sid, så en
// spiller der genindlæser, får en frisk forbindelse.

let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
// Serveren giver STUN og (hvis sat op) TURN med tidsbegrænset kodeord. Hentes igen når kameraet startes.
async function loadIce() {
  try {
    const res = await fetch('/api/ice', { cache: 'no-store' });
    if (res.ok) ICE = (await res.json()).iceServers;
  } catch { /* behold STUN */ }
}
loadIce();
const POS_ORDER = [0, 1, 2, 3]; // relativt til mig, med uret: mig, venstre, overfor, højre
const sid = Math.random().toString(36).slice(2);

let socket = null;
let me = null; // mit spiller-id
let local = null; // MediaStream fra kamera/mikrofon
let micOn = true;
const peers = new Map(); // spiller-id -> { pc, polite, sid, makingOffer, ignoreOffer, senders, stream, status }
const tiles = new Map(); // spiller-id -> { el, video, label, info }
let column = null, messages = null;

export function initCams(sock) {
  socket = sock;
  column = document.getElementById('cams');
  messages = document.createElement('div');
  messages.className = 'cam-messages';
  column.append(messages); // står altid under kameraerne
  column.addEventListener('click', onClick);
  socket.on('rtc:signal', ({ from, data }) => onSignal(from, data).catch(err => console.warn('WebRTC', err)));
  socket.on('disconnect', () => { for (const id of [...peers.keys()]) closePeer(id); });
}

// Kaldes ved hver ny tilstand fra serveren. Kameraerne er med, så snart man sidder ved et bord
// (også mens man venter på, at spillet starter).
export function updateCams(state) {
  const t = state?.table;
  const atTable = !!(state?.me && t && t.mySeat >= 0);
  document.body.classList.toggle('with-cams', atTable);
  if (!atTable) {
    if (me || local) leaveTable();
    return;
  }
  me = state.me.id;
  // Kun mennesker har kamera – AI-spillere og tomme pladser får ingen kasse.
  const seats = POS_ORDER.map(i => t.seats[(t.mySeat + i) % 4]).filter(p => p && !p.bot);
  const others = seats.filter(p => p.id !== me && p.online && p.present !== false);
  for (const p of others) if (!peers.has(p.id)) openPeer(p.id);
  for (const id of [...peers.keys()]) if (!others.some(p => p.id === id)) closePeer(id);
  renderTiles(seats);
}

// ---------- Fliser ----------

let lastSeats = [];
const statusOf = id => (id === me ? myStatus() : peers.get(id)?.status);
const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; }; // ellers kan et klik gå tabt

function renderTiles(seats = lastSeats) {
  lastSeats = seats;
  const ids = seats.map(p => p?.id);
  for (const [id, tile] of tiles) if (!ids.includes(id)) { tile.el.remove(); tiles.delete(id); }
  seats.forEach((p, i) => {
    let tile = tiles.get(p.id);
    if (!tile) {
      tiles.set(p.id, tile = makeTile(p.id === me));
      tile.video.srcObject = p.id === me ? local : peers.get(p.id)?.stream ?? null;
    }
    if (column.children[i] !== tile.el) column.insertBefore(tile.el, column.children[i] ?? null);
    const status = statusOf(p.id);
    tile.label.textContent = p.name;
    tile.el.classList.toggle('has-video', !!status?.video);
    tile.el.classList.toggle('muted', !!status && !status.audio);
    const away = !p.online || p.present === false;
    tile.el.classList.toggle('offline', away);
    tile.info.textContent = away ? 'ikke ved bordet' : status?.video ? '' : 'kamera slukket';
    if (p.id === me) {
      setHtml(tile.controls, local
        ? `<button data-cam="mic" title="${micOn ? 'Slå mikrofonen fra' : 'Slå mikrofonen til'}">${micOn ? '🎤' : '🔇'}</button>`
          + '<button data-cam="stop" title="Sluk kamera og mikrofon">⏹</button>'
        : '<button data-cam="start" class="primary">Tænd kamera</button>');
    }
  });
}

function makeTile(mine) {
  const el = document.createElement('div');
  el.className = `cam-tile ${mine ? 'mine' : ''}`;
  el.innerHTML = `<video autoplay playsinline ${mine ? 'muted' : ''}></video>
    <div class="cam-info"></div><div class="cam-name"></div><span class="cam-mute" title="Mikrofonen er slået fra">🔇</span>
    ${mine ? '<div class="cam-controls"></div>' : ''}`;
  return {
    el, video: el.querySelector('video'), label: el.querySelector('.cam-name'),
    info: el.querySelector('.cam-info'), controls: el.querySelector('.cam-controls'),
  };
}

const refresh = () => renderTiles(); // opdater med det samme, uden at vente på serveren

// Beskeder om kamera og lyd vises i kolonnen under kameraerne (klik for at lukke).
function note(text) {
  const el = document.createElement('div');
  el.className = 'cam-message';
  el.textContent = text;
  el.title = 'Klik for at lukke';
  el.addEventListener('click', () => el.remove());
  messages.append(el);
  setTimeout(() => el.remove(), 8000);
}

function onClick(e) {
  const action = e.target.closest('[data-cam]')?.dataset.cam;
  if (action === 'start') startLocal();
  else if (action === 'stop') stopLocal();
  else if (action === 'mic') setMic(!micOn);
}

// ---------- Eget kamera og mikrofon ----------

async function startLocal() {
  if (!navigator.mediaDevices) {
    // Kamera og mikrofon kræver en sikker side: https:// eller http://localhost.
    note('Kamera og mikrofon virker kun på https:// eller http://localhost – se README under "Webcam og lyd"');
    return;
  }
  await loadIce();
  const video = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } };
  try {
    local = await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (err) {
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: true }); // intet kamera: kun lyd
      note('Kameraet kunne ikke startes – kun mikrofonen er tændt');
    } catch {
      local = null;
      note(err?.name === 'NotAllowedError' ? 'Du har ikke givet adgang til kamera og mikrofon' : 'Kamera og mikrofon kunne ikke startes');
      return;
    }
  }
  micOn = true;
  const tile = tiles.get(me);
  if (tile) tile.video.srcObject = local;
  for (const peer of peers.values()) attachLocal(peer);
  broadcastStatus();
  refresh();
}

function stopLocal() {
  for (const track of local?.getTracks() ?? []) track.stop();
  local = null;
  for (const peer of peers.values()) {
    for (const sender of Object.values(peer.senders)) sender.replaceTrack(null);
  }
  const tile = tiles.get(me);
  if (tile) tile.video.srcObject = null;
  broadcastStatus();
  refresh();
}

function setMic(on) {
  micOn = on;
  for (const track of local?.getAudioTracks() ?? []) track.enabled = on;
  broadcastStatus();
  refresh();
}

// Læg (eller genbrug) afsendere til eget kamera og mikrofon på forbindelsen.
function attachLocal(peer) {
  if (!local) return;
  for (const track of local.getTracks()) {
    const sender = peer.senders[track.kind];
    if (sender) sender.replaceTrack(track);
    else peer.senders[track.kind] = peer.pc.addTrack(track, local);
  }
}

const myStatus = () => ({ video: !!local?.getVideoTracks().length, audio: !!local?.getAudioTracks().length && micOn });
const send = (to, data) => socket.emit('rtc:signal', { to, data: { ...data, sid } });
function broadcastStatus() {
  for (const id of peers.keys()) send(id, { status: myStatus() });
}

function leaveTable() {
  stopLocal();
  for (const id of [...peers.keys()]) closePeer(id);
  for (const tile of tiles.values()) tile.el.remove();
  tiles.clear();
  lastSeats = [];
  me = null;
}

// ---------- Forbindelser ----------

function openPeer(id, remoteSid = null) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const peer = { pc, polite: me > id, sid: remoteSid, makingOffer: false, ignoreOffer: false, senders: {}, stream: null, status: null };
  peers.set(id, peer);
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send(id, { description: pc.localDescription });
    } catch (err) {
      console.warn('WebRTC', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) send(id, { candidate }); };
  pc.ontrack = ({ track, streams }) => {
    peer.stream = streams[0] ?? peer.stream ?? new MediaStream();
    if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
    const tile = tiles.get(id);
    if (tile && tile.video.srcObject !== peer.stream) tile.video.srcObject = peer.stream;
    tile?.video.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    // Forbindelsen er tabt: start forfra (den anden side gør det samme, når den hører fra os).
    if (pc.connectionState === 'failed' && peers.get(id) === peer) { closePeer(id); openPeer(id); }
  };
  attachLocal(peer);
  send(id, { hello: true, status: myStatus() }); // så den anden side ved, at det er en ny forbindelse
  return peer;
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peers.delete(id);
  const tile = tiles.get(id);
  if (tile) tile.video.srcObject = null;
}

async function onSignal(from, data) {
  if (!me) return;
  let peer = peers.get(from);
  // Ny sideindlæsning hos den anden: kassér den gamle forbindelse.
  if (peer && peer.sid && peer.sid !== data.sid) { closePeer(from); peer = null; }
  if (!peer) peer = openPeer(from, data.sid);
  peer.sid = data.sid;
  if (data.status) { peer.status = data.status; refresh(); }
  if (data.hello) return;
  const { pc } = peer;
  if (data.description) {
    const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      await pc.setLocalDescription();
      send(from, { description: pc.localDescription });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) throw err;
    }
  }
}
