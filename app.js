/* Ascensão das Bruxas — Mesa Virtual
   Static tabletop: master/player views, map + fog, tokens, characters, dice, initiative.
   Multiplayer via PeerJS (optional). State persisted in localStorage for offline/local use. */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const nowTime = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s ?? '');

  const ATTRS = [
    ['for', 'Força'], ['des', 'Destreza'], ['con', 'Constituição'],
    ['int', 'Inteligência'], ['sab', 'Sabedoria'], ['car', 'Carisma']
  ];
  const DICE = [2, 4, 6, 8, 10, 12, 20, 100];

  const defaultState = () => ({
    version: 1,
    room: '',
    map: { src: '', cols: 24, rows: 16 },
    fog: { cols: 24, rows: 16, cells: [] }, // cells of revealed "c,r"
    tokens: [],
    characters: [],
    library: [],
    initiative: { order: [], index: -1, round: 1 },
    log: []
  });

  let S = loadLocal() || defaultState();
  let me = { name: '', role: 'player' }; // role: 'gm' | 'player'
  let peer = null, hostConn = null, conns = [];
  let selectedCharId = null;
  let painting = false, paintReveal = false;
  let drag = null; // {id, offsetX, offsetY}
  let saveTimer = null;

  // ---------- persistence & sync ----------
  function storageKey() { return 'adb_mesa_' + (S.room || 'local'); }
  function loadLocal() {
    try {
      const raw = localStorage.getItem('adb_mesa_local') || localStorage.getItem('adb_mesa_');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveLocal() {
    try { localStorage.setItem(storageKey(), JSON.stringify(S)); localStorage.setItem('adb_mesa_local', JSON.stringify(S)); } catch {}
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveLocal(); if (me.role === 'gm') broadcastState(); }, 250); }

  function publicState() {
    // players don't receive hidden-token secrets except existence? hidden tokens removed from their view
    const fog = S.fog;
    return JSON.parse(JSON.stringify(S));
  }
  function playerView() {
    const v = publicState();
    v.tokens = v.tokens.filter(t => !t.hidden);
    return v;
  }
  function broadcastState() {
    if (me.role !== 'gm') return;
    const full = JSON.stringify({ t: 'state', s: publicState() });
    const pv = JSON.stringify({ t: 'state', s: playerView() });
    conns.forEach(c => { if (c.open) try { c.send(c._gm ? full : pv); } catch {} });
  }
  function sendToHost(msg) { if (hostConn && hostConn.open) hostConn.send(msg); }
  function send(msg) {
    if (me.role === 'gm') handleMsg(msg, { _gm: true, _local: true });
    else sendToHost(msg);
  }

  function handleMsg(msg, from) {
    if (!msg) return;
    if (msg.t === 'state' && me.role === 'player') {
      S = msg.s; normalizeState(); renderAll();
    } else if (msg.t === 'hello' && me.role === 'gm') {
      log(`${msg.name || 'Jogador'} entrou na mesa.`);
      if (from && from.send) { from._name = msg.name; try { from.send({ t: 'state', s: playerView() }); } catch {} }
      broadcastState();
    } else if (msg.t === 'log' && me.role === 'gm') {
      addLog(msg.text, msg.kind, false); broadcastState();
    } else if (msg.t === 'roll' && me.role === 'gm') {
      doRoll(msg.die, msg.qty || 1, msg.mod || 0, msg.who || 'Alguém', true);
    } else if (msg.t === 'tokenMove' && me.role === 'gm') {
      const tok = S.tokens.find(t => t.id === msg.id);
      if (tok && canControlToken(tok, msg.who)) { tok.x = msg.x; tok.y = msg.y; addLog(`${msg.who} moveu ${tok.name}.`, 'move', false); scheduleSave(); renderAll(); }
    } else if (msg.t === 'charUpsert' && me.role === 'gm') {
      upsertCharacter(msg.char, false); scheduleSave(); renderAll();
    }
  }

  // ---------- state helpers ----------
  function normalizeState() {
    const d = defaultState();
    S = Object.assign(d, S);
    S.map = Object.assign(d.map, S.map || {});
    S.fog = Object.assign(d.fog, S.fog || {});
    S.initiative = Object.assign(d.initiative, S.initiative || {});
    S.tokens = S.tokens || []; S.characters = S.characters || []; S.library = S.library || []; S.log = S.log || [];
    if (!Array.isArray(S.fog.cells)) S.fog.cells = [];
  }
  function canControlToken(tok, who) {
    if (me.role === 'gm') return true;
    const name = (who || me.name || '').toLowerCase();
    if (!name) return false;
    if ((tok.owner || '').toLowerCase() === name) return true;
    const c = S.characters.find(ch => ch.id === tok.charId);
    return c && (c.owner || '').toLowerCase() === name;
  }
  function myCharacters() {
    if (me.role === 'gm') return S.characters;
    const n = (me.name || '').toLowerCase();
    return S.characters.filter(c => (c.owner || '').toLowerCase() === n || (c.name || '').toLowerCase() === n);
  }
  function charById(id) { return S.characters.find(c => c.id === id); }

  // ---------- logging ----------
  function log(text, kind = 'info') { addLog(text, kind, true); }
  function addLog(text, kind = 'info', emit) {
    S.log.unshift({ id: uid(), text, kind, time: nowTime() });
    S.log = S.log.slice(0, 80);
    renderLog();
    if (emit) {
      if (me.role === 'gm') scheduleSave();
      else sendToHost({ t: 'log', text, kind });
    }
  }
  function renderLog() {
    const ul = $('#logList'); if (!ul) return;
    ul.innerHTML = S.log.map(e => `<li><time>${esc(e.time)}</time>${esc(e.text)}</li>`).join('');
  }

  // ---------- characters ----------
  function blankCharacter() {
    const attrs = {}; ATTRS.forEach(([k]) => attrs[k] = 10);
    return {
      id: uid(), name: 'Novo Personagem', clazz: '', race: '', element: '', level: 1, owner: me.role === 'player' ? me.name : '',
      hp: 10, hpMax: 10, mp: 10, mpMax: 10, san: 10, sanMax: 10, def: 0,
      attrs, inventory: '', powers: '', notes: '', img: ''
    };
  }
  function upsertCharacter(char, emit = true) {
    if (!char.id) char.id = uid();
    const i = S.characters.findIndex(c => c.id === char.id);
    if (i >= 0) S.characters[i] = Object.assign(S.characters[i], char); else S.characters.push(char);
    // sync linked tokens basics
    S.tokens.forEach(t => { if (t.charId === char.id) { t.name = char.name; t.img = char.img || t.img; t.hp = char.hp; t.hpMax = char.hpMax; } });
    if (emit) { if (me.role === 'gm') { log(`Ficha salva: ${char.name}.`); scheduleSave(); } else sendToHost({ t: 'charUpsert', char }); }
    renderCharacters(); renderTokens();
  }
  function deleteCharacter(id) {
    const c = charById(id); if (!c) return;
    S.characters = S.characters.filter(x => x.id !== id);
    if (selectedCharId === id) selectedCharId = null;
    log(`Personagem removido: ${c.name}.`);
    scheduleSave(); renderCharacters(); renderCharForm();
  }

  function renderCharacters() {
    const ul = $('#charList'); if (!ul) return;
    const list = me.role === 'gm' ? S.characters : myCharacters();
    if (!list.length) { ul.innerHTML = `<li class="muted" style="cursor:default">Nenhum personagem ainda.</li>`; return; }
    ul.innerHTML = list.map(c => `
      <li data-id="${c.id}" class="${c.id === selectedCharId ? 'active' : ''}">
        <div><div><strong>${esc(c.name || 'Sem nome')}</strong></div><div class="meta">${esc(c.clazz || '—')} · Nv ${esc(c.level || 1)} · PV ${esc(c.hp)}/${esc(c.hpMax)}</div></div>
        <span class="muted">›</span>
      </li>`).join('');
  }

  function renderCharForm() {
    const empty = $('#sheetEmpty'), body = $('#sheetBody'), form = $('#charForm');
    const c = charById(selectedCharId);
    const canEdit = c && (me.role === 'gm' || (c.owner || '').toLowerCase() === me.name.toLowerCase() || (c.name || '').toLowerCase() === me.name.toLowerCase() || !c.owner);
    if (!c) { empty.classList.remove('hidden'); body.classList.add('hidden'); return; }
    empty.classList.add('hidden'); body.classList.remove('hidden');
    form.name.value = c.name || ''; form.clazz.value = c.clazz || ''; form.race.value = c.race || ''; form.element.value = c.element || '';
    form.level.value = c.level || 1; form.owner.value = c.owner || '';
    form.hp.value = c.hp ?? 0; form.hpMax.value = c.hpMax ?? 1; form.mp.value = c.mp ?? 0; form.mpMax.value = c.mpMax ?? 0;
    form.san.value = c.san ?? 0; form.sanMax.value = c.sanMax ?? 10; form.def.value = c.def ?? 0;
    form.inventory.value = c.inventory || ''; form.powers.value = c.powers || ''; form.notes.value = c.notes || '';
    const p = $('#charPortrait');
    p.style.backgroundImage = c.img ? `url("${c.img}")` : '';
    p.textContent = c.img ? '' : 'Sem imagem';
    // attrs
    const ag = $('#attrGrid'); ag.innerHTML = ATTRS.map(([k, label]) => {
      const v = (c.attrs && c.attrs[k] != null) ? c.attrs[k] : 10;
      const mod = Math.floor((v - 10) / 2);
      return `<div class="attr"><header><span>${label}</span><button type="button" class="btn small ghost" data-roll-attr="${k}">Rolar</button></header>
        <input type="number" name="attr_${k}" value="${v}"><small>Mod ${mod >= 0 ? '+' : ''}${mod}</small></div>`;
    }).join('');
    // disable if cannot edit (player editing others) - but players can usually edit their own
    $$('input,textarea,select,button[type="submit"],#btnCharImage,#btnDeleteChar,#btnCharToToken', form).forEach(el => {
      if (el.id === 'btnCharToToken') el.disabled = !(me.role === 'gm'); else el.disabled = !canEdit && me.role !== 'gm';
    });
  }

  function readCharForm() {
    const c = charById(selectedCharId); if (!c) return null;
    const f = $('#charForm');
    c.name = f.name.value.trim() || c.name; c.clazz = f.clazz.value.trim(); c.race = f.race.value.trim(); c.element = f.element.value.trim();
    c.level = +f.level.value || 1; c.owner = f.owner.value.trim();
    c.hp = +f.hp.value || 0; c.hpMax = Math.max(1, +f.hpMax.value || 1);
    c.mp = +f.mp.value || 0; c.mpMax = Math.max(0, +f.mpMax.value || 0);
    c.san = +f.san.value || 0; c.sanMax = Math.max(1, +f.sanMax.value || 10); c.def = +f.def.value || 0;
    c.inventory = f.inventory.value; c.powers = f.powers.value; c.notes = f.notes.value;
    c.attrs = c.attrs || {}; ATTRS.forEach(([k]) => { c.attrs[k] = +f[`attr_${k}`].value || 0; });
    return c;
  }

  // ---------- tokens & map ----------
  function boardRect() { return $('#board').getBoundingClientRect(); }
  function addToken(data) {
    const t = Object.assign({ id: uid(), name: 'Token', x: 50, y: 50, size: 1, color: '#8b6cf6', img: '', hp: 10, hpMax: 10, owner: '', charId: null, hidden: false, inInit: true, initMod: 0, type: 'npc' }, data || {});
    S.tokens.push(t); scheduleSave(); renderTokens(); renderTokenAdmin(); return t;
  }
  function tokenPixelSize(t) {
    const b = $('#board'); const cell = Math.min(b.clientWidth / S.map.cols, b.clientHeight / S.map.rows);
    return clamp(cell * (t.size || 1) * 0.9, 28, 140);
  }
  function renderTokens() {
    const layer = $('#tokenLayer'); if (!layer) return;
    layer.innerHTML = '';
    S.tokens.forEach(t => {
      if (me.role !== 'gm' && t.hidden) return;
      const el = document.createElement('div');
      el.className = 'token' + (t.hidden ? ' hidden-token' : '');
      el.dataset.id = t.id;
      const px = tokenPixelSize(t);
      el.style.width = px + 'px'; el.style.height = px + 'px';
      el.style.left = t.x + '%'; el.style.top = t.y + '%';
      el.style.backgroundColor = t.color || '#666';
      if (t.img) el.style.backgroundImage = `url("${t.img}")`;
      const pct = t.hpMax > 0 ? clamp((t.hp / t.hpMax) * 100, 0, 100) : 0;
      el.innerHTML = `${t.img ? '' : `<span class="label">${esc((t.name||'?').slice(0,2).toUpperCase())}</span>`}<span class="hpbar"><i style="width:${pct}%"></i></span>`;
      if (S.initiative.order[S.initiative.index] === t.id) el.classList.add('selected');
      el.addEventListener('pointerdown', onTokenPointerDown);
      el.addEventListener('click', (e) => { if (me.role === 'gm') { e.stopPropagation(); openTokenModal(t.id); } });
      layer.appendChild(el);
    });
  }
  function onTokenPointerDown(e) {
    const id = e.currentTarget.dataset.id; const t = S.tokens.find(x => x.id === id); if (!t) return;
    if (!canControlToken(t)) return;
    e.preventDefault();
    const rect = boardRect();
    drag = { id, startX: e.clientX, startY: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onBoardPointerMove(e) {
    if (painting && me.role === 'gm') { paintFogAtEvent(e); return; }
    if (!drag) return;
    const t = S.tokens.find(x => x.id === drag.id); if (!t) return;
    const rect = boardRect();
    const dx = ((e.clientX - drag.startX) / rect.width) * 100;
    const dy = ((e.clientY - drag.startY) / rect.height) * 100;
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) drag.moved = true;
    drag.startX = e.clientX; drag.startY = e.clientY;
    t.x = clamp(t.x + dx, 0, 100); t.y = clamp(t.y + dy, 0, 100);
    const el = $(`.token[data-id="${t.id}"]`); if (el) { el.style.left = t.x + '%'; el.style.top = t.y + '%'; }
  }
  function onBoardPointerUp(e) {
    if (painting) { painting = false; return; }
    if (!drag) return;
    const t = S.tokens.find(x => x.id === drag.id);
    drag = null;
    if (t) {
      if (me.role === 'gm') { scheduleSave(); } else { sendToHost({ t: 'tokenMove', id: t.id, x: t.x, y: t.y, who: me.name }); }
    }
  }

  function renderMap() {
    const map = $('#mapLayer');
    map.style.backgroundImage = S.map.src ? `url("${S.map.src}")` : 'none';
    drawGrid(); drawFog();
  }
  function drawGrid() {
    const c = $('#gridCanvas'), b = $('#board'); if (!c || !b) return;
    c.width = b.clientWidth; c.height = b.clientHeight;
    const ctx = c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height);
    if (!$('#toggleGrid').checked) return;
    const cols = S.map.cols, rows = S.map.rows;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    for (let i=0;i<=cols;i++){ const x = (i/cols)*c.width; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,c.height); ctx.stroke(); }
    for (let j=0;j<=rows;j++){ const y = (j/rows)*c.height; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(c.width,y); ctx.stroke(); }
  }

  // ---------- fog of war (revealed cells set) ----------
  function fogKey(c,r){return c+','+r;}
  function isRevealed(c,r){ return S.fog.cells && S.fog.cells.includes(fogKey(c,r)); }
  function setRevealed(c,r,val){
    const k = fogKey(c,r); const i = S.fog.cells.indexOf(k);
    if (val && i < 0) S.fog.cells.push(k);
    if (!val && i >= 0) S.fog.cells.splice(i,1);
  }
  function drawFog() {
    const c = $('#fogCanvas'), b = $('#board'); if (!c || !b) return;
    c.width = b.clientWidth; c.height = b.clientHeight;
    const ctx = c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height);
    const cols = S.map.cols, rows = S.map.rows;
    const cw = c.width/cols, ch = c.height/rows;
    const fogColor = (me.role === 'gm') ? 'rgba(10,8,18,0.55)' : 'rgba(5,4,10,0.96)';
    ctx.fillStyle = fogColor;
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
      if (!isRevealed(x,y)) ctx.fillRect(x*cw, y*ch, cw+1, ch+1);
    }
    if (me.role === 'gm') {
      ctx.strokeStyle = 'rgba(184,149,255,0.08)';
      for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) if (isRevealed(x,y)) ctx.strokeRect(x*cw,y*ch,cw,ch);
    }
  }
  function paintFogAtEvent(e) {
    const rect = boardRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width-1);
    const y = clamp(e.clientY - rect.top, 0, rect.height-1);
    const col = Math.floor((x / rect.width) * S.map.cols);
    const row = Math.floor((y / rect.height) * S.map.rows);
    const mode = $('#fogMode').value; // hide/reveal
    setRevealed(col,row, mode === 'reveal');
    drawFog();
  }
  function onBoardPointerDown(e) {
    if (e.target.closest('.token')) return;
    if (me.role === 'gm' && $('#fogPaint').checked) {
      painting = true; paintFogAtEvent(e); scheduleSave();
      $('#board').setPointerCapture(e.pointerId);
    }
  }
  function coverAllFog(reveal) {
    S.fog.cells = [];
    if (reveal) { for(let y=0;y<S.map.rows;y++) for(let x=0;x<S.map.cols;x++) S.fog.cells.push(fogKey(x,y)); }
    drawFog(); scheduleSave();
  }

  // ---------- dice ----------
  function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }
  function spawnDieVisual(value, sides, label) {
    const stage = $('#diceStage'); if (!stage) return;
    const d = document.createElement('div');
    d.className = 'die d' + sides + (sides === 20 && value === 20 ? ' crit' : '') + (sides === 20 && value === 1 ? ' fumble' : '');
    const tx = (Math.random() * 40 - 20).toFixed(0) + 'px';
    d.style.left = (30 + Math.random() * 40) + '%'; d.style.top = (35 + Math.random() * 30) + '%';
    d.style.setProperty('--tx', tx);
    d.innerHTML = `<span>${value}</span><span class="faces">d${sides}</span>`;
    stage.appendChild(d);
    setTimeout(() => d.remove(), 3200);
  }
  function doRoll(die, qty, mod, who, fromNet) {
    qty = clamp(parseInt(qty)||1,1,10); mod = parseInt(mod)||0;
    const results = []; for (let i=0;i<qty;i++) results.push(rollDie(die));
    const total = results.reduce((a,b)=>a+b,0) + mod;
    results.forEach((v,i)=> setTimeout(()=>spawnDieVisual(v, die), i*120));
    const txt = `${who} rolou ${qty>1?qty+'×':''}d${die}${mod? (mod>0?`+${mod}`:`${mod}`):''}: [${results.join(', ')}]${(qty>1||mod)?` = ${total}`:''}`;
    addLog(txt, 'roll', false);
    if (me.role === 'gm') { scheduleSave(); broadcastState(); }
    else if (!fromNet) { /* already sent */ }
    renderLog();
  }
  function requestRoll(die) {
    const qty = $('#diceQty').value; const mod = $('#diceMod').value;
    if (me.role === 'gm') doRoll(die, qty, mod, me.name || 'Mestre', false);
    else sendToHost({ t: 'roll', die, qty, mod, who: me.name || 'Jogador' });
  }

  // ---------- initiative ----------
  function modFromAttr(score){ return Math.floor(((+score||10)-10)/2); }
  function rollInitiative() {
    const entries = [];
    S.tokens.forEach(t => {
      if (t.hidden || t.inInit === false) return;
      let mod = +t.initMod || 0;
      if (t.charId) { const c = charById(t.charId); if (c && c.attrs) mod += modFromAttr(c.attrs.des); }
      const roll = rollDie(20);
      entries.push({ id: t.id, name: t.name, roll, mod, total: roll + mod });
    });
    entries.sort((a,b)=> b.total - a.total || b.mod - a.mod);
    S.initiative.order = entries.map(e=>e.id);
    S.initiative.details = entries;
    S.initiative.index = entries.length ? 0 : -1;
    S.initiative.round = 1;
    log(`Iniciativa rolada automaticamente (${entries.length} combatentes).`);
    scheduleSave(); renderInitiative(); renderTokens();
  }
  function nextTurn() {
    const o = S.initiative.order || []; if (!o.length) return;
    S.initiative.index++;
    if (S.initiative.index >= o.length) { S.initiative.index = 0; S.initiative.round = (S.initiative.round||1)+1; log(`Rodada ${S.initiative.round}.`); }
    const id = o[S.initiative.index]; const t = S.tokens.find(x=>x.id===id);
    if (t) log(`Turno: ${t.name}.`, 'turn');
    scheduleSave(); renderInitiative(); renderTokens();
  }
  function clearInitiative() { S.initiative = { order: [], details: [], index: -1, round: 1 }; log('Iniciativa limpa.'); scheduleSave(); renderInitiative(); renderTokens(); }
  function renderInitiative() {
    const ol = $('#initList'), empty = $('#initEmpty');
    const det = S.initiative.details || [];
    if (!det.length) { ol.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    ol.innerHTML = det.map((e, i) => `<li class="${i === S.initiative.index ? 'active':''}">${esc(e.name)} <span class="val">${e.total}</span> <span class="muted">(${e.roll}${e.mod? (e.mod>0?`+${e.mod}`:e.mod):''})</span></li>`).join('');
  }

  // ---------- GM token admin & modal ----------
  function renderTokenAdmin() {
    const ul = $('#tokenList'); if (!ul) return;
    if (!S.tokens.length) { ul.innerHTML = `<li class="muted" style="cursor:default">Nenhum token no mapa.</li>`; return; }
    ul.innerHTML = S.tokens.map(t => `<li>
      <div><strong>${esc(t.name)}</strong> <span class="muted">PV ${esc(t.hp)}/${esc(t.hpMax)} ${t.hidden?'· oculto':''}</span></div>
      <div class="actions"><button class="btn small" data-edit-token="${t.id}">Editar</button><button class="btn small ghost" data-del-token="${t.id}">✕</button></div>
    </li>`).join('');
  }
  function renderLibrary() {
    const ul = $('#libraryList'); if (!ul) return;
    if (!S.library.length) { ul.innerHTML = `<li class="muted" style="cursor:default">Importe um grimoire (.json) com NPCs.</li>`; return; }
    ul.innerHTML = S.library.map((n,i)=>`<li><div><strong>${esc(n.n||n.name)}</strong> <span class="muted">${n.hp?('PV '+n.hp):''}</span></div>
      <div class="actions"><button class="btn small" data-lib="${i}">Colocar</button></div></li>`).join('');
  }
  function openTokenModal(id) {
    const t = S.tokens.find(x=>x.id===id); if (!t) return;
    const modal = $('#modal'), form = $('#tokenForm');
    form.dataset.id = id;
    form.innerHTML = `
      <label>Nome <input name="name" value="${esc(t.name)}"></label>
      <div class="grid2">
        <label>PV atual <input name="hp" type="number" value="${t.hp}"></label>
        <label>PV máximo <input name="hpMax" type="number" value="${t.hpMax}"></label>
        <label>Tamanho (células) <input name="size" type="number" min="1" max="6" value="${t.size||1}"></label>
        <label>Mod. iniciativa <input name="initMod" type="number" value="${t.initMod||0}"></label>
        <label>Cor <input name="color" type="color" value="${esc(t.color||'#8b6cf6')}"></label>
        <label>Dono (jogador) <input name="owner" value="${esc(t.owner||'')}"></label>
      </div>
      <div class="row wrap">
        <label class="toggle"><input type="checkbox" name="hidden" ${t.hidden?'checked':''}> Oculto dos jogadores</label>
        <label class="toggle"><input type="checkbox" name="inInit" ${t.inInit!==false?'checked':''}> Entra na iniciativa</label>
      </div>
      <div class="row wrap">
        <button type="button" class="btn small" id="btnTokenImg">Imagem do token</button>
        <button type="button" class="btn small ghost" id="btnTokenImgClear">Remover imagem</button>
        <button type="submit" class="btn primary">Salvar</button>
        <button type="button" class="btn danger ghost" id="btnTokenDelete">Excluir token</button>
      </div>`;
    modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false');
    $('#btnTokenImg').onclick = () => pickImage(512, (src)=>{ t.img = src; scheduleSave(); renderTokens(); });
    $('#btnTokenImgClear').onclick = () => { t.img = ''; scheduleSave(); renderTokens(); };
    $('#btnTokenDelete').onclick = () => { S.tokens = S.tokens.filter(x=>x.id!==id); closeModal(); scheduleSave(); renderAll(); };
  }
  function closeModal(){ const m=$('#modal'); m.classList.add('hidden'); m.setAttribute('aria-hidden','true'); }

  // ---------- images & grimoire ----------
  function pickImage(max, cb) {
    const inp = $('#imagePicker');
    inp.onchange = () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w=img.width, h=img.height; const scale = Math.min(1, max / Math.max(w,h));
          w = Math.round(w*scale); h = Math.round(h*scale);
          const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
          cv.getContext('2d').drawImage(img,0,0,w,h);
          cb(cv.toDataURL('image/jpeg', 0.85));
        }; img.src = r.result;
      }; r.readAsDataURL(f); inp.value='';
    };
    inp.click();
  }
  async function loadBundledGrimoire() {
    try {
      const res = await fetch('grimoire-campanha.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.npcs)) S.library = data.npcs;
      renderLibrary();
    } catch {}
  }
  function importGrimoireFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (Array.isArray(data.npcs)) S.library = data.npcs;
        else if (Array.isArray(data)) S.library = data;
        if (Array.isArray(data.characters)) data.characters.forEach(c=>upsertCharacter(c,false));
        log('Grimoire importado com sucesso.'); scheduleSave(); renderLibrary(); renderCharacters();
      } catch { alert('Arquivo de grimoire inválido.'); }
    }; r.readAsText(file);
  }

  // ---------- render all / layout ----------
  function renderAll() {
    document.body.classList.toggle('is-gm', me.role === 'gm');
    $('#roomTitle').textContent = S.room ? `Sala ${S.room}` : 'Mesa local';
    $('#roomMeta').textContent = me.role === 'gm' ? `Mestre: ${me.name}` : `Jogador: ${me.name}`;
    $('#gridCols').value = S.map.cols; $('#gridRows').value = S.map.rows;
    renderMap(); renderTokens(); renderInitiative(); renderLog(); renderCharacters(); renderCharForm(); renderTokenAdmin(); renderLibrary();
  }

  // ---------- networking ----------
  function setConn(text, ok){ const b=$('#connBadge'); b.textContent=text; b.classList.toggle('ok', !!ok); }
  function startHost(room) {
    me.role = 'gm'; S.room = room || ''; normalizeState(); if (S.fog.cells.length===0) coverAllFog(false);
    showApp(); renderAll(); saveLocal();
    if (!room) { setConn('local', true); return; }
    setConn('abrindo...', false);
    peer = new Peer('adb-' + room, { debug: 0 });
    peer.on('open', () => setConn('online', true));
    peer.on('connection', c => {
      conns.push(c);
      c.on('open', ()=>{ try { c.send({ t:'state', s: playerView() }); } catch{} });
      c.on('data', msg => handleMsg(msg, c));
      c.on('close', ()=>{ conns = conns.filter(x=>x!==c); log('Um jogador saiu.'); });
    });
    peer.on('error', err => { setConn('erro', false); alert('Erro de conexão: ' + err.type); });
  }
  function startJoin(room) {
    me.role = 'player'; S.room = room; normalizeState(); showApp(); setConn('conectando...', false);
    peer = new Peer();
    peer.on('open', () => {
      hostConn = peer.connect('adb-' + room, { reliable: true });
      hostConn.on('open', () => { setConn('online', true); hostConn.send({ t:'hello', name: me.name }); });
      hostConn.on('data', msg => handleMsg(msg, hostConn));
      hostConn.on('close', () => { setConn('desconectado', false); log('Conexão com o mestre perdida.'); });
      hostConn.on('error', () => setConn('erro', false));
    });
    peer.on('error', err => { setConn('erro', false); alert('Não foi possível conectar: ' + err.type + '. Verifique o código e se o mestre está online.'); });
  }

  // ---------- UI wiring ----------
  function showApp(){ $('#lobby').classList.add('hidden'); const app=$('#app'); app.classList.remove('hidden'); app.setAttribute('aria-hidden','false'); }
  function showLobby(){ $('#app').classList.add('hidden'); $('#lobby').classList.remove('hidden'); }

  function bind() {
    $('#btnHost').onclick = () => { me.name = $('#playerName').value.trim() || 'Mestre'; const room = $('#roomCode').value.trim().toUpperCase(); startHost(room); };
    $('#btnJoin').onclick = () => { me.name = $('#playerName').value.trim() || 'Jogador'; const room = $('#roomCode').value.trim().toUpperCase(); if(!room){ $('#lobbyMsg').textContent='Informe o código da sala para entrar como jogador.'; return;} startJoin(room); };
    $('#btnSolo').onclick = () => { me.name = $('#playerName').value.trim() || 'Mestre'; startHost(''); };
    $('#btnLeave').onclick = () => location.reload();

    // tabs
    $$('.tab').forEach(btn => btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      $$('.tab').forEach(b=>b.classList.toggle('active', b===btn));
      $$('.view').forEach(v=>{ const on = v.id===view; v.hidden=!on; v.classList.toggle('active', on); });
      if (view==='view-table') { setTimeout(()=>{ drawGrid(); drawFog(); renderTokens(); }, 30); }
    }));

    // dice
    $$('.die-btn').forEach(b => b.addEventListener('click', ()=> requestRoll(parseInt(b.dataset.die,10))));
    $('#btnClearLog').onclick = () => { S.log=[]; renderLog(); if(me.role==='gm') scheduleSave(); };

    // initiative
    $('#btnRollInit').onclick = rollInitiative;
    $('#btnNextTurn').onclick = nextTurn;
    $('#btnClearInit').onclick = clearInitiative;

    // board interactions
    const board = $('#board');
    board.addEventListener('pointerdown', onBoardPointerDown);
    window.addEventListener('pointermove', onBoardPointerMove);
    window.addEventListener('pointerup', onBoardPointerUp);
    $('#toggleGrid').onchange = drawGrid;
    $('#btnFit').onclick = () => { drawGrid(); drawFog(); renderTokens(); };
    window.addEventListener('resize', () => { drawGrid(); drawFog(); renderTokens(); });

    // characters
    $('#btnNewChar').onclick = () => { const c = blankCharacter(); S.characters.push(c); selectedCharId = c.id; log(`Novo personagem criado.`); scheduleSave(); renderCharacters(); renderCharForm(); };
    $('#charList').onclick = (e) => { const li = e.target.closest('li[data-id]'); if(!li) return; selectedCharId = li.dataset.id; renderCharacters(); renderCharForm(); };
    $('#charForm').addEventListener('submit', (e)=>{ e.preventDefault(); const c = readCharForm(); if(c) upsertCharacter(c,true); });
    $('#charForm').addEventListener('input', (e)=>{
      if (e.target.name && e.target.name.startsWith('attr_')) {
        // live mod update
        const k = e.target.name.replace('attr_',''); const mod = Math.floor(((+e.target.value||10)-10)/2);
        const small = e.target.parentElement.querySelector('small'); if (small) small.textContent = `Mod ${mod>=0?'+':''}${mod}`;
      }
    });
    $('#charForm').addEventListener('click', (e)=>{
      const rb = e.target.closest('[data-roll-attr]'); if (rb) {
        const c = charById(selectedCharId); if(!c) return; const k = rb.dataset.rollAttr; const mod = modFromAttr(c.attrs?.[k]||10);
        if (me.role==='gm') doRoll(20,1,mod,`${c.name} (${k.toUpperCase()})`,false); else sendToHost({t:'roll',die:20,qty:1,mod,who:`${c.name} (${k.toUpperCase()})`});
      }
    });
    $('#btnCharImage').onclick = () => { const c=charById(selectedCharId); if(!c) return; pickImage(512,(src)=>{ c.img=src; renderCharForm(); }); };
    $('#btnDeleteChar').onclick = () => { if(selectedCharId && confirm('Excluir este personagem?')) deleteCharacter(selectedCharId); };
    $('#btnCharToToken').onclick = () => {
      const c = readCharForm() || charById(selectedCharId); if(!c) return;
      addToken({ name:c.name, img:c.img, hp:c.hp, hpMax:c.hpMax, owner:c.owner, charId:c.id, color:'#7de0c3', type:'pc' });
      log(`Token criado para ${c.name}.`); renderTokens();
    };
    $('#btnImportGrimoire').onclick = () => $('#grimoireFile').click();
    $('#grimoireFile').onchange = (e)=>{ const f=e.target.files[0]; if(f) importGrimoireFile(f); e.target.value=''; };

    // GM panel
    $('#btnMapUpload').onclick = () => pickImage(2000,(src)=>{ S.map.src=src; log('Mapa atualizado.'); scheduleSave(); renderMap(); });
    $('#btnMapClear').onclick = () => { S.map.src=''; log('Mapa removido.'); scheduleSave(); renderMap(); };
    $('#btnApplyGrid').onclick = () => { S.map.cols=clamp(+$('#gridCols').value||24,5,60); S.map.rows=clamp(+$('#gridRows').value||16,5,60); log(`Grid: ${S.map.cols}x${S.map.rows}.`); scheduleSave(); drawGrid(); drawFog(); renderTokens(); };
    $('#btnFogCover').onclick = () => { coverAllFog(false); log('Névoa: mapa coberto.'); };
    $('#btnFogReveal').onclick = () => { coverAllFog(true); log('Névoa: mapa revelado.'); };
    $('#btnAddEnemy').onclick = () => { addToken({ name:'Inimigo', color:'#ff6b6b', type:'enemy', hp:10, hpMax:10 }); log('Token de inimigo adicionado.'); };
    $('#btnAddNpc').onclick = () => { addToken({ name:'NPC', color:'#6bbcff', type:'npc', inInit:false }); log('Token de NPC adicionado.'); };
    $('#btnAddPlayers').onclick = () => {
      S.characters.forEach((c,i)=>{
        if (S.tokens.some(t=>t.charId===c.id)) return;
        addToken({ name:c.name, img:c.img, hp:c.hp, hpMax:c.hpMax, owner:c.owner, charId:c.id, color:'#7de0c3', type:'pc', x: 10 + (i%8)*10, y: 80 });
      });
      log('Tokens dos personagens garantidos no mapa.'); renderTokens();
    };

    $('#tokenList').onclick = (e)=>{
      const ed = e.target.closest('[data-edit-token]'); const del = e.target.closest('[data-del-token]');
      if (ed) openTokenModal(ed.dataset.editToken);
      if (del) { S.tokens = S.tokens.filter(t=>t.id!==del.dataset.delToken); scheduleSave(); renderAll(); }
    };
    $('#libraryList').onclick = (e)=>{
      const b = e.target.closest('[data-lib]'); if(!b) return; const n=S.library[+b.dataset.lib]; if(!n) return;
      addToken({ name:n.n||n.name||'Criatura', hp:n.hp||10, hpMax:n.hp||10, hidden:true, inInit: !!n.hp, type:'npc', color:'#6bbcff' });
      log(`Criatura colocada: ${n.n||n.name}.`); renderTokens();
    };

    // modal
    $('#modal').addEventListener('click', (e)=>{ if(e.target.dataset.close) closeModal(); });
    $('#tokenForm').addEventListener('submit', (e)=>{
      e.preventDefault(); const id=e.target.dataset.id; const t=S.tokens.find(x=>x.id===id); if(!t) return;
      const f=e.target; t.name=f.name.value; t.hp=+f.hp.value||0; t.hpMax=+f.hpMax.value||1; t.size=clamp(+f.size.value||1,1,6);
      t.initMod=+f.initMod.value||0; t.color=f.color.value; t.owner=f.owner.value.trim(); t.hidden=f.hidden.checked; t.inInit=f.inInit.checked;
      // sync to char
      if (t.charId){ const c=charById(t.charId); if(c){ c.hp=t.hp; c.hpMax=t.hpMax; c.name=t.name; } }
      closeModal(); scheduleSave(); renderAll();
    });
  }

  // ---------- init ----------
  function init() {
    normalizeState();
    bind();
    loadBundledGrimoire();
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
