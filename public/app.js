/* Deluxe Meet — video calls in the browser.
 *
 * Calls are peer to peer (WebRTC): video and sound go straight between the
 * people in the call. PeerJS's signalling server only introduces them.
 *
 * Every person has a random peer id. One person in each meeting also holds the
 * meeting's "front desk" id (deluxe-meet-v1-<code>); newcomers knock there and
 * are told who is already in, then call each of them. If the front desk leaves,
 * someone else in the call takes it over.
 *
 * Signing in, names and the meeting history come from Deluxe Main (deluxe.js). */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const CONFIG = window.MEET_CONFIG || {};
const PREFIX = 'deluxe-meet-v1-';
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '😮'];
const LOCAL_HISTORY = 'meet.history';
const NAME_KEY = 'meet.name';
const MAX_PEOPLE = 12;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const Deluxe = () => window.Deluxe || null;
const deluxeUser = () => (Deluxe() ? Deluxe().user() : null);

/* ---------------- small helpers ---------------- */

function randomCode() {
  const letters = 'abcdefghijkmnopqrstuvwxyz';
  const pick = new Uint8Array(10);
  crypto.getRandomValues(pick);
  const s = Array.from(pick, (n) => letters[n % letters.length]).join('');
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
}
function randomId(n = 10) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => (x % 36).toString(36)).join('');
}
// "abc-defg-hij", "abcdefghij", or any link containing a code.
function parseCode(text) {
  const t = String(text || '').trim().toLowerCase();
  const m = /([a-z]{3})-?([a-z]{4})-?([a-z]{3})(?![a-z])/.exec(t.replace(/^https?:\/\/[^/]+/, ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function inviteLink(code) { return `${location.origin}/${code}`; }
function initial(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
function hue(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.codePointAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 58%), hsl(${(h + 50) % 360} 65% 45%))`;
}
function cleanName(n) { return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40); }
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
function setIcon(button, name) { button.querySelector('use').setAttribute('href', `#i-${name}`); }
function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}
async function copyLink(code) {
  const link = inviteLink(code);
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch (e) {
    window.prompt('Copy this invite link', link);
  }
}
function show(id) {
  for (const s of ['home', 'prejoin', 'call', 'left']) $(`#${s}`).hidden = s !== id;
  document.body.classList.toggle('in-call', id === 'call');
}

/* ---------------- state ---------------- */

const S = {
  code: null,
  name: '',
  micOn: true,
  camOn: true,
  hand: false,
  // Real devices.
  cam: null, // camera video track
  mic: null, // microphone audio track
  screen: null, // screen video track while presenting
  micId: '',
  camId: '',
  // What is sent to everyone: always one audio and one video track.
  send: null,
  sendAudio: null,
  sendVideo: null,
  blank: null,
  silent: null,
  peer: null,
  desk: null, // the front-desk peer, while this person holds it
  deskMembers: null,
  deskConn: null,
  myId: '',
  peers: new Map(),
  joinedAt: 0,
  everyone: new Set(),
  pinned: null,
  panel: null,
  unread: false,
  leaving: false,
  timer: null,
  audio: null,
};

/* ---------------- media ---------------- */

function audioCtx() {
  if (!S.audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    S.audio = AC ? new AC() : null;
  }
  if (S.audio && S.audio.state === 'suspended') S.audio.resume().catch(() => {});
  return S.audio;
}

// A black frame, sent while the camera is off (so a video track always exists).
function blankTrack() {
  if (S.blank && S.blank.readyState === 'live') return S.blank;
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d');
  let n = 0;
  const paint = () => { g.fillStyle = n++ % 2 ? '#0b0a14' : '#0b0a15'; g.fillRect(0, 0, c.width, c.height); };
  paint();
  setInterval(paint, 1000);
  S.blank = c.captureStream(2).getVideoTracks()[0];
  return S.blank;
}
// Silence, when there is no microphone.
function silentTrack() {
  if (S.silent && S.silent.readyState === 'live') return S.silent;
  const ctx = audioCtx();
  if (!ctx) return null;
  const dest = ctx.createMediaStreamDestination();
  S.silent = dest.stream.getAudioTracks()[0];
  return S.silent;
}

function videoConstraints() {
  return Object.assign({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, S.camId ? { deviceId: { exact: S.camId } } : {});
}
function audioConstraints() {
  return Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, S.micId ? { deviceId: { exact: S.micId } } : {});
}

async function openCamera() {
  const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
  return s.getVideoTracks()[0];
}
async function openMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
  return s.getAudioTracks()[0];
}

// Ask for the camera and microphone. Either may be missing or refused.
async function startDevices() {
  const notes = [];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return ['This browser cannot use a camera or microphone here. Use a recent browser over https.'];
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: S.camOn ? videoConstraints() : false });
    S.mic = s.getAudioTracks()[0] || null;
    S.cam = s.getVideoTracks()[0] || null;
  } catch (e) {
    try { S.mic = await openMic(); } catch (e2) { notes.push(mediaError(e2, 'microphone')); }
    if (S.camOn) {
      try { S.cam = await openCamera(); } catch (e3) { notes.push(mediaError(e3, 'camera')); }
    }
  }
  if (!S.mic) S.micOn = false;
  if (S.camOn && !S.cam) S.camOn = false;
  if (S.mic) S.mic.enabled = S.micOn;
  return notes;
}
function mediaError(e, what) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return `The ${what} is blocked. Allow it in your browser's address bar to use it.`;
  if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return `No ${what} was found.`;
  if (e && e.name === 'NotReadableError') return `The ${what} is being used by another app.`;
  return `Could not open the ${what}.`;
}

function currentVideo() { return S.screen || (S.camOn && S.cam) || blankTrack(); }
function currentAudio() { return S.mic || silentTrack(); }

function buildSendStream() {
  S.sendAudio = currentAudio();
  S.sendVideo = currentVideo();
  S.send = new MediaStream([S.sendAudio, S.sendVideo].filter(Boolean));
}

// Swap what is being sent, without calling anyone again.
function replaceSent(kind, track) {
  if (!S.send || !track) return;
  const old = kind === 'audio' ? S.sendAudio : S.sendVideo;
  if (old === track) return;
  if (old) S.send.removeTrack(old);
  S.send.addTrack(track);
  if (kind === 'audio') S.sendAudio = track;
  else S.sendVideo = track;
  for (const p of S.peers.values()) {
    const pc = p.call && p.call.peerConnection;
    if (!pc) continue;
    for (const sender of pc.getSenders()) {
      if ((sender.track && sender.track.kind === kind) || (!sender.track && senderKind(pc, sender) === kind)) {
        sender.replaceTrack(track).catch(() => {});
      }
    }
  }
}
function senderKind(pc, sender) {
  const t = pc.getTransceivers().find((x) => x.sender === sender);
  return t && t.receiver && t.receiver.track ? t.receiver.track.kind : '';
}

/* ---------------- voice levels ---------------- */

const meters = new Map(); // element -> { analyser, data, source }
function meter(el, stream) {
  unmeter(el);
  const ctx = audioCtx();
  if (!ctx || !stream || !stream.getAudioTracks().length) return;
  try {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    meters.set(el, { analyser, source, data: new Uint8Array(analyser.fftSize), held: 0 });
  } catch (e) {}
}
function unmeter(el) {
  const m = meters.get(el);
  if (m) { try { m.source.disconnect(); } catch (e) {} meters.delete(el); }
}
function levelOf(m) {
  m.analyser.getByteTimeDomainData(m.data);
  let sum = 0;
  for (const v of m.data) { const x = (v - 128) / 128; sum += x * x; }
  return Math.sqrt(sum / m.data.length);
}
setInterval(() => {
  for (const [el, m] of meters) {
    if (!el.isConnected) { unmeter(el); continue; }
    const level = levelOf(m);
    if (el.id === 'pre-level') { el.style.height = `${Math.min(100, level * 600)}%`; continue; }
    const muted = el.dataset.self === '1' ? !S.micOn : el.classList.contains('mic-off');
    if (level > 0.03 && !muted) m.held = 4;
    else if (m.held > 0) m.held--;
    el.classList.toggle('speaking', m.held > 0);
  }
}, 120);

/* ---------------- home ---------------- */

function codeFromUrl() {
  const fromPath = parseCode(decodeURIComponent(location.pathname.replace(/^\/+/, '')));
  if (fromPath) return fromPath;
  return parseCode(new URLSearchParams(location.search).get('room') || '');
}

async function loadHistory() {
  const u = deluxeUser();
  if (u && Deluxe()) {
    try {
      const items = await Deluxe().data.list({ prefix: 'call:', order: 'desc', limit: 12 });
      return items.map((i) => i.value).filter((v) => v && v.code);
    } catch (e) { /* fall back to this browser's list */ }
  }
  try { return JSON.parse(store.get(LOCAL_HISTORY) || '[]'); } catch (e) { return []; }
}
async function saveHistory(entry) {
  const local = (await loadLocal()).filter((e) => e.at !== entry.at);
  local.unshift(entry);
  store.set(LOCAL_HISTORY, JSON.stringify(local.slice(0, 12)));
  if (deluxeUser() && Deluxe()) {
    const key = `call:${new Date(entry.at).toISOString()}`;
    try { await Deluxe().data.put(key, entry); } catch (e) {}
  }
}
async function loadLocal() { try { return JSON.parse(store.get(LOCAL_HISTORY) || '[]'); } catch (e) { return []; } }

async function drawHome() {
  const signedIn = !!deluxeUser();
  $('#signin-hint').hidden = signedIn || !Deluxe();
  const list = $('#recent-list');
  const items = await loadHistory();
  list.textContent = '';
  for (const it of items.slice(0, 8)) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'r-text';
    const code = document.createElement('div');
    code.className = 'r-code';
    code.textContent = it.code;
    const sub = document.createElement('div');
    sub.className = 'r-sub';
    const when = new Date(it.at);
    const others = (it.people || []).filter(Boolean);
    sub.textContent = `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${fmtDuration(it.duration || 0)}${others.length ? ' · with ' + others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '') : ''}`;
    text.append(code, sub);
    const go = document.createElement('a');
    go.className = 'btn ghost';
    go.href = `/${it.code}`;
    go.textContent = 'Rejoin';
    li.append(text, go);
    list.appendChild(li);
  }
  $('#recent-empty').hidden = items.length > 0;
}

$('#new-meeting').onclick = () => {
  const code = randomCode();
  history.pushState(null, '', `/${code}`);
  route();
};
$('#join-code').oninput = () => {
  $('#join-go').disabled = !$('#join-code').value.trim();
  $('#join-error').hidden = true;
};
$('#join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = parseCode($('#join-code').value);
  if (!code) {
    $('#join-error').textContent = 'That is not a meeting code. Codes look like abc-defg-hij.';
    $('#join-error').hidden = false;
    return;
  }
  history.pushState(null, '', `/${code}`);
  route();
};
$('#signin-link').onclick = () => Deluxe() && Deluxe().signIn();

/* ---------------- pre-join ---------------- */

let previewOn = false;

function defaultName() {
  const u = deluxeUser();
  return cleanName((u && u.name) || store.get(NAME_KEY) || '');
}

async function startPrejoin() {
  show('prejoin');
  $('#pre-room').textContent = S.code;
  document.title = `${S.code} · Deluxe Meet`;
  const u = deluxeUser();
  $('#pre-name').value = defaultName();
  $('#pre-who').textContent = u
    ? `Signed in with Deluxe Main as ${u.name}.`
    : Deluxe() ? 'Joining as a guest. Sign in with Deluxe Main (top right) to save your meetings.' : 'Joining as a guest.';
  $('#pre-error').hidden = true;
  drawPreviewAvatar();
  if (!previewOn) {
    previewOn = true;
    const notes = await startDevices();
    showPreviewNotes(notes);
    await fillDeviceLists();
  }
  drawPreview();
  setTimeout(() => { if (!$('#pre-name').value) $('#pre-name').focus(); }, 50);
}
function showPreviewNotes(notes) {
  $('#preview-msg').textContent = notes.join(' ');
  $('#preview-msg').hidden = !notes.length;
}
function drawPreviewAvatar() {
  const n = cleanName($('#pre-name').value) || defaultName();
  $('#preview-avatar').textContent = initial(n);
  $('#preview-avatar').style.setProperty('--av', hue(n || '?'));
}
function drawPreview() {
  const v = $('#preview-video');
  const showCam = S.camOn && S.cam;
  v.srcObject = showCam ? new MediaStream([S.cam]) : null;
  $('#preview').classList.toggle('no-video', !showCam);
  $('#preview').classList.toggle('mirror', !!showCam);
  setToggle($('#pre-mic'), 'mic', S.micOn, !S.mic);
  setToggle($('#pre-cam'), 'cam', S.camOn, false);
  if (S.mic) meter($('#pre-level'), new MediaStream([S.mic]));
  $('#pre-level').parentElement.hidden = !S.mic || !S.micOn;
}
function setToggle(btn, kind, on, disabled) {
  btn.setAttribute('aria-pressed', String(on));
  setIcon(btn, on ? kind : `${kind}-off`);
  const what = kind === 'mic' ? 'microphone' : 'camera';
  btn.title = `${on ? 'Turn off' : 'Turn on'} ${what}${btn.id.startsWith('b-') ? (kind === 'mic' ? ' (Ctrl+D)' : ' (Ctrl+E)') : ''}`;
  btn.setAttribute('aria-label', btn.title);
  btn.disabled = !!disabled;
}

async function fillDeviceLists() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
  const fill = (sel, kind, current) => {
    sel.textContent = '';
    const list = devices.filter((d) => d.kind === kind);
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}`;
      sel.appendChild(o);
    });
    if (current) sel.value = current;
    sel.disabled = list.length < 2;
  };
  fill($('#pre-mic-select'), 'audioinput', S.mic && S.mic.getSettings().deviceId);
  fill($('#pre-cam-select'), 'videoinput', S.cam && S.cam.getSettings().deviceId);
}
$('#pre-mic-select').onchange = async (e) => {
  S.micId = e.target.value;
  try {
    const t = await openMic();
    if (S.mic) S.mic.stop();
    S.mic = t;
    S.mic.enabled = S.micOn = true;
    drawPreview();
  } catch (err) { showPreviewNotes([mediaError(err, 'microphone')]); }
};
$('#pre-cam-select').onchange = async (e) => {
  S.camId = e.target.value;
  try {
    const t = await openCamera();
    if (S.cam) S.cam.stop();
    S.cam = t;
    S.camOn = true;
    drawPreview();
  } catch (err) { showPreviewNotes([mediaError(err, 'camera')]); }
};
$('#pre-name').oninput = drawPreviewAvatar;
$('#pre-mic').onclick = async () => { await toggleMic(); drawPreview(); };
$('#pre-cam').onclick = async () => { await toggleCam(); drawPreview(); };
$('#copy-pre').onclick = () => copyLink(S.code);

$('#prejoin-form').onsubmit = (e) => {
  e.preventDefault();
  const name = cleanName($('#pre-name').value);
  if (!name) {
    $('#pre-error').textContent = 'Type your name so people know who you are.';
    $('#pre-error').hidden = false;
    $('#pre-name').focus();
    return;
  }
  S.name = name;
  if (!deluxeUser()) store.set(NAME_KEY, name);
  joinCall();
};

/* ---------------- mic / camera / screen ---------------- */

async function toggleMic(force) {
  const want = typeof force === 'boolean' ? force : !S.micOn;
  if (want && !S.mic) {
    try { S.mic = await openMic(); } catch (e) { toast(mediaError(e, 'microphone'), true); return; }
    replaceSent('audio', S.mic);
    if (S.peer) meter(selfTile(), new MediaStream([S.mic]));
  }
  S.micOn = want;
  if (S.mic) S.mic.enabled = want;
  afterLocalChange();
}

async function toggleCam(force) {
  const want = typeof force === 'boolean' ? force : !S.camOn;
  if (want) {
    if (!S.cam || S.cam.readyState !== 'live') {
      try { S.cam = await openCamera(); } catch (e) { toast(mediaError(e, 'camera'), true); return; }
    }
    S.camOn = true;
  } else {
    S.camOn = false;
    // Stopping the track turns the camera light off.
    if (S.cam) { S.cam.stop(); S.cam = null; }
  }
  if (!S.screen) replaceSent('video', currentVideo());
  afterLocalChange();
}

async function toggleScreen() {
  if (S.screen) return stopScreen();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('This browser cannot share its screen.', true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    S.screen = s.getVideoTracks()[0];
    try { S.screen.contentHint = 'detail'; } catch (e) {}
    S.screen.onended = () => stopScreen();
    replaceSent('video', S.screen);
    S.pinned = null;
    afterLocalChange();
    toast('You are presenting to everyone');
  } catch (e) {
    if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Could not share the screen.', true);
  }
}
function stopScreen() {
  if (!S.screen) return;
  const t = S.screen;
  S.screen = null;
  t.onended = null;
  t.stop();
  replaceSent('video', currentVideo());
  afterLocalChange();
}

function afterLocalChange() {
  if (!S.peer) return;
  drawSelf();
  broadcast(stateMessage());
  drawControls();
  layout();
  drawPeople();
}

function drawControls() {
  setToggle($('#b-mic'), 'mic', S.micOn, false);
  setToggle($('#b-cam'), 'cam', S.camOn, false);
  $('#b-screen').setAttribute('aria-pressed', String(!!S.screen));
  $('#b-screen').title = S.screen ? 'Stop presenting' : 'Present your screen';
  $('#b-hand').setAttribute('aria-pressed', String(S.hand));
  $('#b-hand').title = S.hand ? 'Lower hand' : 'Raise hand';
}

/* ---------------- tiles ---------------- */

function makeTile(id, name, self) {
  const t = document.createElement('div');
  t.className = `tile${self ? ' self' : ''} no-video`;
  t.dataset.id = id;
  if (self) t.dataset.self = '1';
  const v = document.createElement('video');
  v.playsInline = true;
  v.autoplay = true;
  if (self) v.muted = true;
  const av = document.createElement('div');
  av.className = 'avatar';
  const badges = document.createElement('div');
  badges.className = 'badges';
  const label = document.createElement('div');
  label.className = 'label';
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'pin';
  pin.appendChild(icon('pin'));
  pin.onclick = (e) => {
    e.stopPropagation();
    S.pinned = S.pinned === id ? null : id;
    layout();
  };
  t.ondblclick = () => pin.click();
  t.append(v, av, badges, label, pin);
  if (!self) {
    const c = document.createElement('div');
    c.className = 'connecting';
    c.textContent = 'Connecting…';
    t.appendChild(c);
  }
  drawTileInfo(t, { name, mic: true, cam: false, hand: false, screen: false, self });
  return t;
}
function drawTileInfo(t, info) {
  const name = info.name || 'Guest';
  t.querySelector('.avatar').textContent = initial(name);
  t.querySelector('.avatar').style.setProperty('--av', hue(name));
  const label = t.querySelector('.label');
  label.textContent = '';
  if (!info.mic) {
    const ic = icon('mic-off');
    ic.classList.add('muted-ic');
    label.appendChild(ic);
  }
  const span = document.createElement('span');
  span.textContent = info.self ? `${name} (You)` : name;
  label.appendChild(span);
  const badges = t.querySelector('.badges');
  badges.textContent = '';
  if (info.hand) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.append(icon('hand'), document.createTextNode('Hand raised'));
    badges.appendChild(b);
  }
  if (info.screen) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.append(icon('screen'), document.createTextNode(info.self ? 'You are presenting' : 'Presenting'));
    badges.appendChild(b);
  }
  t.classList.toggle('mic-off', !info.mic);
  t.classList.toggle('screen', !!info.screen);
  t.classList.toggle('no-video', !info.cam && !info.screen);
  t.querySelector('.pin').title = 'Pin to the main screen';
  t.querySelector('.pin').setAttribute('aria-label', `Pin ${name}`);
}

function selfTile() { return $('#stage .tile.self'); }
function drawSelf() {
  let t = selfTile();
  if (!t) {
    t = makeTile(S.myId, S.name, true);
    $('#stage').prepend(t);
    if (S.mic) meter(t, new MediaStream([S.mic]));
  }
  const showing = S.screen || (S.camOn && S.cam);
  const v = t.querySelector('video');
  const want = showing ? showing.id : '';
  if (v.dataset.track !== want) {
    v.dataset.track = want;
    v.srcObject = showing ? new MediaStream([showing]) : null;
  }
  t.classList.toggle('mirror', !S.screen && !!showing);
  drawTileInfo(t, { name: S.name, mic: S.micOn, cam: S.camOn && !!S.cam, hand: S.hand, screen: !!S.screen, self: true });
}

function layout() {
  const stage = $('#stage');
  const tiles = [...stage.querySelectorAll('.tile')];
  const n = tiles.length;
  // Who goes on the main screen: pinned, else whoever presents.
  let main = null;
  if (S.pinned) main = tiles.find((t) => t.dataset.id === S.pinned) || null;
  if (!main) main = tiles.find((t) => t.classList.contains('screen') && !t.classList.contains('self')) || null;
  if (!main && S.screen && n > 1) main = null; // presenting yourself: keep the grid
  if (!main && S.pinned) S.pinned = null;
  tiles.forEach((t) => t.classList.toggle('pinned', t.dataset.id === S.pinned));
  const spot = !!main && n > 1;
  stage.classList.toggle('spot', spot);
  tiles.forEach((t) => { t.classList.remove('main', 'overflow'); t.style.order = ''; });
  if (spot) {
    main.classList.add('main');
    let k = 0;
    tiles.forEach((t) => {
      if (t === main) return;
      k++;
      t.classList.toggle('overflow', k > 4);
    });
    stage.style.setProperty('--side-rows', String(Math.max(1, Math.min(4, n - 1))));
    main.style.order = '-1';
    return;
  }
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  // Choose the column count that makes 16:9 tiles largest.
  let best = 1, bestArea = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = (w - (cols - 1) * 10) / cols;
    const th = (h - (rows - 1) * 10) / rows;
    const fit = Math.min(tw, th * 16 / 9);
    if (fit > bestArea) { bestArea = fit; best = cols; }
  }
  stage.style.setProperty('--cols', String(best));
  const rows = Math.ceil(n / best);
  stage.style.gridAutoRows = n === 1 ? 'minmax(0, 1fr)' : `minmax(0, ${Math.min((h - (rows - 1) * 10) / rows, (bestArea * 9) / 16)}px)`;
}
window.addEventListener('resize', () => { if (S.peer) layout(); });

/* ---------------- people panel ---------------- */

function everyoneInfo() {
  const list = [{ id: S.myId, name: S.name, mic: S.micOn, cam: S.camOn && !!S.cam, hand: S.hand, screen: !!S.screen, self: true, account: !!deluxeUser() }];
  for (const p of S.peers.values()) if (p.hello) list.push(p);
  return list;
}
function drawPeople() {
  const all = everyoneInfo();
  $('#people-count').textContent = String(all.length);
  $('#bar-count').textContent = String(all.length);
  const ul = $('#people');
  ul.textContent = '';
  for (const p of all) {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'p-av';
    av.textContent = initial(p.name);
    av.style.setProperty('--av', hue(p.name || '?'));
    const nm = document.createElement('span');
    nm.className = 'p-name';
    nm.textContent = p.self ? `${p.name} (You)` : p.name || 'Guest';
    const small = document.createElement('small');
    small.textContent = p.account ? 'Deluxe account' : 'Guest';
    nm.appendChild(small);
    const ic = document.createElement('span');
    ic.className = 'p-ic';
    if (p.hand) ic.appendChild(icon('hand'));
    if (p.screen) ic.appendChild(icon('screen'));
    const mic = icon(p.mic ? 'mic' : 'mic-off');
    if (!p.mic) mic.classList.add('off');
    ic.appendChild(mic);
    li.append(av, nm, ic);
    ul.appendChild(li);
  }
}

function openPanel(which) {
  if (S.panel === which) which = null;
  S.panel = which;
  $('#panel').hidden = !which;
  $('#b-chat').setAttribute('aria-pressed', String(which === 'chat'));
  $('#b-people').setAttribute('aria-pressed', String(which === 'people'));
  if (which) {
    $('#tab-chat').setAttribute('aria-selected', String(which === 'chat'));
    $('#tab-people').setAttribute('aria-selected', String(which === 'people'));
    $('#panel-chat').hidden = which !== 'chat';
    $('#panel-people').hidden = which !== 'people';
  }
  if (which === 'chat') {
    S.unread = false;
    $('#chat-dot').hidden = true;
    setTimeout(() => $('#chat-input').focus(), 30);
    scrollChat();
  }
  requestAnimationFrame(layout);
}
$('#b-chat').onclick = () => openPanel('chat');
$('#b-people').onclick = () => openPanel('people');
$('#tab-chat').onclick = () => { S.panel = null; openPanel('chat'); };
$('#tab-people').onclick = () => { S.panel = null; openPanel('people'); };
$('#panel-close').onclick = () => openPanel(null);
$('#copy-people').onclick = () => copyLink(S.code);
$('#call-room').onclick = () => copyLink(S.code);

/* ---------------- chat & reactions ---------------- */

function addMessage(name, text, at, self) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'm-head';
  const b = document.createElement('b');
  b.textContent = self ? 'You' : name;
  const time = document.createElement('span');
  time.textContent = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  head.append(b, time);
  const body = document.createElement('div');
  body.className = 'm-text';
  body.textContent = text;
  li.append(head, body);
  $('#messages').appendChild(li);
  scrollChat();
  if (!self && S.panel !== 'chat') {
    S.unread = true;
    $('#chat-dot').hidden = false;
    toast(`${name}: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`);
  }
}
function systemMessage(text) {
  const li = document.createElement('li');
  li.className = 'sys';
  li.textContent = text;
  $('#messages').appendChild(li);
  scrollChat();
}
function scrollChat() { const m = $('#messages'); m.scrollTop = m.scrollHeight; }
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim().slice(0, 1000);
  if (!text) return;
  $('#chat-input').value = '';
  const at = Date.now();
  broadcast({ t: 'chat', text, at });
  addMessage(S.name, text, at, true);
};

const reactBox = $('#reactions');
for (const r of REACTIONS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = r;
  b.setAttribute('aria-label', `React ${r}`);
  b.onclick = () => {
    broadcast({ t: 'react', emoji: r });
    floatReaction(selfTile(), r);
    reactBox.hidden = true;
    $('#b-react').setAttribute('aria-expanded', 'false');
  };
  reactBox.appendChild(b);
}
$('#b-react').onclick = (e) => {
  e.stopPropagation();
  reactBox.hidden = !reactBox.hidden;
  $('#b-react').setAttribute('aria-expanded', String(!reactBox.hidden));
};
document.addEventListener('click', (e) => {
  if (!reactBox.hidden && !reactBox.contains(e.target)) { reactBox.hidden = true; $('#b-react').setAttribute('aria-expanded', 'false'); }
});
function floatReaction(tile, emoji) {
  if (!tile) return;
  const f = document.createElement('span');
  f.className = 'float';
  f.textContent = emoji;
  f.style.left = `${15 + Math.random() * 60}%`;
  tile.appendChild(f);
  setTimeout(() => f.remove(), 2700);
}

/* ---------------- controls ---------------- */

$('#b-mic').onclick = () => toggleMic();
$('#b-cam').onclick = () => toggleCam();
$('#b-screen').onclick = () => toggleScreen();
$('#b-hand').onclick = () => {
  S.hand = !S.hand;
  afterLocalChange();
};
$('#b-leave').onclick = () => leaveCall();
$('#rejoin').onclick = () => { previewOn = false; route(); };
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) $('#b-screen').hidden = true;

document.addEventListener('keydown', (e) => {
  if (!S.peer || !(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'd') { e.preventDefault(); toggleMic(); }
  if (k === 'e') { e.preventDefault(); toggleCam(); }
});

/* ---------------- the call (PeerJS) ---------------- */

function peerOptions() {
  const o = Object.assign({ debug: 0 }, CONFIG.peer || {});
  if (CONFIG.iceServers) o.config = { iceServers: CONFIG.iceServers };
  return o;
}

// A Peer that is connected to the signalling server, or an error.
function openPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new window.Peer(id, peerOptions());
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      p.destroy();
      reject(Object.assign(new Error('The call server did not answer.'), { type: 'timeout' }));
    }, 12000);
    p.once('open', () => { if (done) return; done = true; clearTimeout(timer); resolve(p); });
    p.once('error', (e) => { if (done) return; done = true; clearTimeout(timer); p.destroy(); reject(e); });
  });
}

function stateMessage() {
  return { t: 'state', name: S.name, mic: S.micOn, cam: S.camOn && !!S.cam, hand: S.hand, screen: !!S.screen, account: !!deluxeUser(), desk: !!S.desk };
}
function send(p, msg) {
  if (p.conn && p.conn.open) { try { p.conn.send(msg); } catch (e) {} }
}
function broadcast(msg) { for (const p of S.peers.values()) send(p, msg); }

async function joinCall() {
  if (!window.Peer) {
    $('#pre-error').textContent = 'Deluxe Meet could not load. Check your connection and reload.';
    $('#pre-error').hidden = false;
    return;
  }
  $('#join-now').disabled = true;
  $('#join-now').textContent = 'Joining…';
  audioCtx();
  buildSendStream();
  S.myId = `${PREFIX}${S.code}-${randomId()}`;
  try {
    S.peer = await openPeer(S.myId);
  } catch (e) {
    $('#join-now').disabled = false;
    $('#join-now').textContent = 'Join now';
    $('#pre-error').textContent = e.type === 'browser-incompatible'
      ? 'This browser cannot make video calls. Try a recent Chrome, Edge, Firefox or Safari.'
      : 'Could not reach the call server. Check your connection and try again.';
    $('#pre-error').hidden = false;
    S.peer = null;
    return;
  }
  S.leaving = false;
  S.joinedAt = Date.now();
  S.everyone = new Set();
  S.peer.on('call', onIncomingCall);
  S.peer.on('connection', onIncomingConn);
  S.peer.on('disconnected', () => { if (!S.leaving && S.peer && !S.peer.destroyed) setTimeout(() => S.peer && !S.peer.destroyed && S.peer.reconnect(), 1000); });
  S.peer.on('error', onPeerError);

  $('#join-now').disabled = false;
  $('#join-now').textContent = 'Join now';
  show('call');
  $('#stage').textContent = '';
  $('#messages').textContent = '';
  $('#call-room').textContent = S.code;
  systemMessage(`You joined ${S.code}`);
  drawSelf();
  drawControls();
  drawPeople();
  layout();
  S.timer = setInterval(() => { $('#call-time').textContent = fmtDuration(Date.now() - S.joinedAt); }, 1000);
  $('#call-time').textContent = '00:00';
  history.replaceState(null, '', `/${S.code}`);
  findFrontDesk();
}

function onPeerError(e) {
  if (S.leaving) return;
  if (e.type === 'peer-unavailable') {
    const m = /peer\s+(\S+)/i.exec(e.message || '');
    const who = m ? m[1] : '';
    if (who === PREFIX + S.code) deskLost();
    else if (who && S.peers.has(who)) dropPeer(who, true);
    return;
  }
  if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
    toast('Reconnecting to the call server…', true);
    return;
  }
  console.warn('Deluxe Meet:', e.type, e.message);
}

/* Front desk: one person holds the meeting's id and tells newcomers who is in. */

async function findFrontDesk() {
  if (S.leaving) return;
  const deskId = PREFIX + S.code;
  try {
    const desk = await openPeer(deskId);
    if (S.leaving) { desk.destroy(); return; }
    becomeDesk(desk);
  } catch (e) {
    if (S.leaving) return;
    if (e.type === 'unavailable-id') knockAtDesk();
    else setTimeout(findFrontDesk, 3000);
  }
}

function becomeDesk(desk) {
  S.desk = desk;
  S.deskMembers = new Map([[S.myId, Date.now()]]);
  for (const id of S.peers.keys()) S.deskMembers.set(id, Date.now());
  desk.on('connection', (c) => {
    c.on('data', (m) => {
      if (!m || m.t !== 'join' || typeof m.id !== 'string' || !m.id.startsWith(PREFIX + S.code + '-')) return;
      c.memberId = m.id;
      const ids = [...S.deskMembers.keys()].filter((x) => x !== m.id && (x === S.myId || S.peers.has(x) || Date.now() - S.deskMembers.get(x) < 45000));
      if (ids.length >= MAX_PEOPLE && !S.deskMembers.has(m.id)) {
        c.send({ t: 'full' });
      } else {
        c.send({ t: 'members', ids });
        S.deskMembers.set(m.id, Date.now());
      }
      setTimeout(() => c.close(), 1500);
    });
  });
  desk.on('disconnected', () => { if (!S.leaving && !desk.destroyed) setTimeout(() => !desk.destroyed && desk.reconnect(), 1000); });
  desk.on('error', (e) => { if (e.type !== 'peer-unavailable') console.warn('Deluxe Meet desk:', e.type); });
  broadcast(stateMessage());
}

// Knock at the front desk: on joining, and then now and again ("check in"), so
// that if the desk changed hands everyone still finds everyone.
let knockTimer = null;
let knocking = false;
function knockAtDesk(checkIn) {
  if (S.leaving || !S.peer || S.desk || knocking) return;
  knocking = true;
  const c = S.peer.connect(PREFIX + S.code, { reliable: true });
  S.deskConn = c;
  let answered = false;
  clearTimeout(knockTimer);
  knockTimer = setTimeout(() => { knocking = false; if (!answered) { try { c.close(); } catch (e) {} deskLost(); } }, 10000);
  c.on('close', () => { knocking = false; });
  c.on('open', () => c.send({ t: 'join', id: S.myId }));
  c.on('data', (m) => {
    if (!m) return;
    answered = true;
    knocking = false;
    clearTimeout(knockTimer);
    if (m.t === 'full') {
      toast(`This meeting is full (${MAX_PEOPLE} people).`, true);
      leaveCall(true);
      return;
    }
    if (m.t === 'members' && Array.isArray(m.ids)) {
      for (const id of m.ids) if (typeof id === 'string' && id.startsWith(PREFIX + S.code + '-')) connectTo(id);
      if (!m.ids.length && !checkIn && !S.peers.size) systemMessage('Nobody else is here yet. Share the invite link.');
    }
  });
}

// The front desk is gone (or never answered): someone takes it over.
let deskRetry = null;
function deskLost() {
  knocking = false;
  if (S.leaving || S.desk || deskRetry) return;
  // The longest-connected people try first.
  deskRetry = setTimeout(() => { deskRetry = null; findFrontDesk(); }, 300 + Math.random() * 1500);
}
// Whoever holds the desk keeps the member list honest; everyone else checks the desk is still there.
setInterval(() => {
  if (!S.peer || S.leaving) return;
  if (S.desk) {
    for (const id of S.peers.keys()) S.deskMembers.set(id, Date.now());
    if (S.desk.disconnected && !S.desk.destroyed) S.desk.reconnect();
  } else if (!deskRetry && Math.random() < 0.6) {
    knockAtDesk(true);
  }
}, 12000);

function ensurePeer(id) {
  let p = S.peers.get(id);
  if (!p) {
    p = { id, name: 'Guest', mic: true, cam: false, hand: false, screen: false, hello: false, call: null, conn: null, stream: null, tile: null, since: Date.now() };
    S.peers.set(id, p);
    // The tile appears once they have said hello or their video arrives.
    p.tile = makeTile(id, '…', false);
    // Never connected after a while: give up on this one.
    setTimeout(() => { if (S.peers.get(id) === p && !p.stream && !p.hello) dropPeer(id, true); }, 25000);
  }
  return p;
}

function showTile(p) {
  if (p.tile.isConnected || !S.peers.has(p.id)) return;
  $('#stage').appendChild(p.tile);
  layout();
}

function connectTo(id) {
  if (id === S.myId || S.peers.has(id) || S.leaving) return;
  const p = ensurePeer(id);
  p.connOut = p.callOut = true;
  wireConn(p, S.peer.connect(id, { reliable: true }));
  wireCall(p, S.peer.call(id, S.send));
}
// If two people call each other at the same moment, the call started by the
// lower id is kept.
function onIncomingConn(c) {
  if (!c.peer.startsWith(PREFIX + S.code + '-') || S.leaving) { c.close(); return; }
  const p = ensurePeer(c.peer);
  if (p.conn && p.connOut && S.myId < c.peer) { c.close(); return; }
  p.connOut = false;
  wireConn(p, c);
}
function onIncomingCall(call) {
  if (!call.peer.startsWith(PREFIX + S.code + '-') || S.leaving) { call.close(); return; }
  const p = ensurePeer(call.peer);
  if (p.call && p.callOut && S.myId < call.peer) { call.close(); return; }
  p.callOut = false;
  call.answer(S.send);
  wireCall(p, call);
}

function wireConn(p, c) {
  const old = p.conn;
  p.conn = c;
  if (old && old !== c) { try { old.close(); } catch (e) {} }
  const hello = () => send(p, Object.assign(stateMessage(), { t: 'hello' }));
  if (c.open) hello();
  else c.on('open', hello);
  c.on('data', (m) => onMessage(p, m));
  c.on('close', () => { if (p.conn === c) dropPeer(p.id); });
  c.on('error', () => {});
}
function wireCall(p, call) {
  const old = p.call;
  p.call = call;
  if (old && old !== call) { try { old.close(); } catch (e) {} }
  call.on('stream', (stream) => {
    p.stream = stream;
    const v = p.tile.querySelector('video');
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {
        toast('Tap anywhere to hear the call');
        document.addEventListener('click', () => v.play().catch(() => {}), { once: true });
      });
    }
    const c = p.tile.querySelector('.connecting');
    if (c) c.remove();
    showTile(p);
    meter(p.tile, stream);
  });
  call.on('close', () => { if (p.call === call) dropPeer(p.id); });
  call.on('error', () => {});
  const pc = call.peerConnection;
  if (pc) {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') dropPeer(p.id);
      if (pc.connectionState === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected') dropPeer(p.id); }, 8000);
    });
  }
}

function onMessage(p, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello' || m.t === 'state') {
    const first = !p.hello;
    p.name = cleanName(m.name) || 'Guest';
    p.mic = !!m.mic;
    p.cam = !!m.cam;
    p.hand = !!m.hand;
    const wasPresenting = p.screen;
    p.screen = !!m.screen;
    p.account = !!m.account;
    p.desk = !!m.desk;
    p.hello = true;
    drawTileInfo(p.tile, p);
    showTile(p);
    if (first) {
      S.everyone.add(p.name);
      toast(`${p.name} joined`);
      systemMessage(`${p.name} joined`);
    }
    if (p.hand && m.t === 'state' && !p.handShown) toast(`${p.name} raised a hand`);
    p.handShown = p.hand;
    if (p.screen && !wasPresenting) toast(`${p.name} is presenting`);
    layout();
    drawPeople();
  } else if (m.t === 'chat' && typeof m.text === 'string') {
    addMessage(p.name, m.text.slice(0, 1000), Number(m.at) || Date.now(), false);
  } else if (m.t === 'react' && REACTIONS.includes(m.emoji)) {
    floatReaction(p.tile, m.emoji);
  } else if (m.t === 'bye') {
    dropPeer(p.id);
  }
}

function dropPeer(id, quiet) {
  const p = S.peers.get(id);
  if (!p) return;
  S.peers.delete(id);
  if (S.deskMembers) S.deskMembers.delete(id);
  try { p.call && p.call.close(); } catch (e) {}
  try { p.conn && p.conn.close(); } catch (e) {}
  if (p.tile) { unmeter(p.tile); p.tile.remove(); }
  // The front desk left: knock again soon; if nobody answers, someone takes it over.
  if (p.desk && !S.leaving && !S.desk) setTimeout(() => knockAtDesk(true), 300 + Math.random() * 1500);
  if (S.pinned === id) S.pinned = null;
  if (p.hello && !quiet && !S.leaving) {
    toast(`${p.name} left`);
    systemMessage(`${p.name} left`);
  }
  layout();
  drawPeople();
}

function leaveCall(silent) {
  if (!S.peer) return;
  S.leaving = true;
  broadcast({ t: 'bye' });
  const people = [...S.everyone];
  const duration = Date.now() - S.joinedAt;
  for (const id of [...S.peers.keys()]) dropPeer(id, true);
  clearInterval(S.timer);
  clearTimeout(knockTimer);
  clearTimeout(deskRetry);
  deskRetry = null;
  const peer = S.peer, desk = S.desk;
  S.peer = null;
  S.desk = null;
  S.deskMembers = null;
  setTimeout(() => { try { peer.destroy(); } catch (e) {} try { desk && desk.destroy(); } catch (e) {} }, 300);
  stopScreen();
  for (const t of [S.cam, S.mic]) if (t) t.stop();
  S.cam = S.mic = null;
  previewOn = false;
  meters.clear();
  const entry = { code: S.code, at: S.joinedAt, duration, people: people.slice(0, 20) };
  if (duration > 3000) saveHistory(entry);
  if (silent === 'unload') return;
  $('#left-info').textContent = `${S.code} · ${fmtDuration(duration)}${people.length ? ' · with ' + people.slice(0, 4).join(', ') : ''}`;
  document.title = 'Deluxe Meet';
  show('left');
}
window.addEventListener('pagehide', () => { if (S.peer) leaveCall('unload'); });
window.addEventListener('beforeunload', (e) => { if (S.peer && S.peers.size) { e.preventDefault(); e.returnValue = ''; } });

// Browsers start sound only after a click or key press.
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { if (S.audio && S.audio.state === 'suspended') S.audio.resume().catch(() => {}); }, true);

/* ---------------- routing & start ---------------- */

function route() {
  if (S.peer) return;
  const code = codeFromUrl();
  if (code) {
    S.code = code;
    startPrejoin();
  } else {
    if (location.pathname !== '/' && !location.search.includes('room=')) history.replaceState(null, '', '/');
    if (S.cam || S.mic) { for (const t of [S.cam, S.mic]) if (t) t.stop(); S.cam = S.mic = null; previewOn = false; }
    document.title = 'Deluxe Meet';
    show('home');
    drawHome();
  }
}
window.addEventListener('popstate', route);

function tick() {
  const now = new Date();
  $('#clock').textContent = `${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
tick();
setInterval(tick, 15000);

async function start() {
  const D = Deluxe();
  if (D) {
    D.button($('#account'));
    try { await D.ready; } catch (e) {}
    D.onChange(() => {
      if (!$('#home').hidden) drawHome();
      if (!$('#prejoin').hidden) startPrejoin();
    });
  }
  route();
}
start();
