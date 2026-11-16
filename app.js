/* KAKA RPG — Ascensão das Bruxas (atualizado)
   Mestre cadastra personagens, define barras/atributos/limites/poderes e vincula jogadores.
   Jogadores controlam personagens vinculados, movem tokens e ajustam status. */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const nowTime = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const normName = (s) => String(s || '').trim().toLowerCase();

  const ATTRS = [
    ['for','Força'],['des','Destreza'],['con','Constituição'],
    ['int','Inteligência'],['sab','Sabedoria'],['car','Carisma']
  ];
  const POWER_FIELDS = [
    ['nome','Nome'],['gasto','Gasto'],['elemento','Elemento (você escolhe)'],['tipoDano','Tipo de dano'],
    ['tempo','Tempo de conjuração'],['alcance','Alcance'],['componentes','Componentes (V/S/M)'],
    ['duracao','Duração'],['dados','Dados / Dificuldade']
  ];

  const defaultState = () => ({
    version: 2,
    room: '',
    map: { src: '', cols: 24, rows: 16 },
    fog: { cells: [] },
    tokens: [],
    characters: [],
    library: [],
    initiative: { order: [], details: [], index: -1, round: 1 },
    log: []
  });

  let S = loadLocal() || defaultState();
  let me = { name: '', role: 'player' };
  let peer = null, hostConn = null, conns = [];
  let selectedCharId = null;
  let painting = false;
  let drag = null;
  let saveTimer = null;

  function storageKey() { return 'kakarpg_' + (S.room || 'local'); }
  function loadLocal() {
    try {
      const raw = localStorage.getItem('kakarpg_local') || localStorage.getItem('adb_mesa_local');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveLocal() {
    try { localStorage.setItem(storageKey(), JSON.stringify(S)); localStorage.setItem('kakarpg_local', JSON.stringify(S)); } catch {}
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveLocal(); if (me.role === 'gm') broadcastState(); }, 250); }

  function blankPower() {
    return { nome:'', gasto:'', descricao:'', elemento:'', tipoDano:'', tempo:'', alcance:'', componentes:'', duracao:'', efeito:'', dados:'' };
  }
  function normalizeCharacter(c) {
    c = c || {};
    c.id = c.id || uid();
    c.name = c.name || 'Personagem';
    c.clazz = c.clazz || ''; c.race = c.race || ''; c.element = c.element || '';
    c.level = c.level || 1; c.owner = c.owner || '';
    c.img = c.img || ''; c.notes = c.notes || '';
    c.attrs = c.attrs || {};
    ATTRS.forEach(([k]) => { if (typeof c.attrs[k] !== 'number') c.attrs[k] = 0; });
    const bars = ['hp','mp','san','def'];
    bars.forEach(b => {
      if (typeof c[b] !== 'number') c[b] = (b==='def'?0:10);
      const mk = b+'Max';
      if (typeof c[mk] !== 'number') c[mk] = (b==='def'?10:10);
      c[mk] = Math.max(0, c[mk]);
      c[b] = clamp(c[b], 0, Math.max(0, c[mk] || 0));
    });
    c.inventoryLimit = Math.max(0, parseInt(c.inventoryLimit ?? 10, 10) || 0);
    if (!Array.isArray(c.inventoryItems)) {
      // migrate old string inventory
      if (typeof c.inventory === 'string' && c.inventory.trim()) c.inventoryItems = c.inventory.split(/\n|,/).map(s=>s.trim()).filter(Boolean);
      else c.inventoryItems = [];
    }
    c.powerSlots = clamp(parseInt(c.powerSlots ?? 3, 10) || 0, 0, 3);
    if (!Array.isArray(c.powers)) c.powers = [];
    while (c.powers.length < 3) c.powers.push(blankPower());
    c.powers = c.powers.slice(0,3).map(p => Object.assign(blankPower(), p||{}));
    return c;
  }
  function normalizeState() {
    const d = defaultState();
    S = Object.assign(d, S);
    S.map = Object.assign(d.map, S.map || {});
    S.fog = Object.assign(d.fog, S.fog || {});
    S.initiative = Object.assign(d.initiative, S.initiative || {});
    S.tokens = Array.isArray(S.tokens) ? S.tokens : [];
    S.characters = Array.isArray(S.characters) ? S.characters.map(normalizeCharacter) : [];
    S.library = Array.isArray(S.library) ? S.library : [];
    S.log = Array.isArray(S.log) ? S.log : [];
    if (!Array.isArray(S.fog.cells)) S.fog.cells = [];
  }

  function playerView() {
    const v = JSON.parse(JSON.stringify(S));
    v.tokens = v.tokens.filter(t => !t.hidden);
    // keep characters so players see/control linked ones
    return v;
  }
  function broadcastState() {
    if (me.role !== 'gm') return;
    const pv = JSON.stringify({ t: 'state', s: playerView() });
    conns.forEach(c => { if (c.open) try { c.send(pv); } catch {} });
  }
  function sendToHost(msg) { if (hostConn && hostConn.open) hostConn.send(msg); }

  function handleMsg(msg, from) {
    if (!msg) return;
    if (msg.t === 'state' && me.role === 'player') {
      S = msg.s; normalizeState(); renderAll();
    } else if (msg.t === 'hello' && me.role === 'gm') {
      if (from) from._name = msg.name;
      addLog(`${msg.name || 'Jogador'} entrou na mesa.`, 'info', false);
      broadcastState();
    } else if (msg.t === 'log' && me.role === 'gm') {
      addLog(msg.text, msg.kind, false); broadcastState();
    } else if (msg.t === 'roll' && me.role === 'gm') {
      doRoll(msg.die, msg.qty||1, msg.mod||0, msg.who||'Alguém', msg.label||'', msg.attrMod||0, true);
    } else if (msg.t === 'tokenMove' && me.role === 'gm') {
      const tok = S.tokens.find(t => t.id === msg.id);
      if (tok && canControlToken(tok, msg.who)) { tok.x = msg.x; tok.y = msg.y; scheduleSave(); renderAll(); }
    } else if (msg.t === 'charPatch' && me.role === 'gm') {
      applyCharPatch(msg.id, msg.patch, msg.who, false);
    }
  }

  function canControlCharacter(c, who) {
    if (!c) return false;
    if (me.role === 'gm') return true;
    const n = normName(who || me.name);
    return n && normName(c.owner) === n;
  }
  function canControlToken(tok, who) {
    if (me.role === 'gm') return true;
    const n = normName(who || me.name);
    if (!n) return false;
    if (normName(tok.owner) === n) return true;
    const c = S.characters.find(ch => ch.id === tok.charId);
    return canControlCharacter(c, n);
  }
  function charById(id) { return S.characters.find(c => c.id === id); }
  function myCharacters() {
    if (me.role === 'gm') return S.characters;
    const n = normName(me.name);
    return S.characters.filter(c => normName(c.owner) === n);
  }

  function addLog(text, kind='info', emit=true) {
    S.log.unshift({ id: uid(), text, kind, time: nowTime() });
    S.log = S.log.slice(0, 100);
    renderLog();
    if (emit) { if (me.role==='gm') { scheduleSave(); } else sendToHost({ t:'log', text, kind }); }
  }
  function log(text, kind='info'){ addLog(text, kind, true); }
  function renderLog() {
    const ul = $('#logList'); if (!ul) return;
    ul.innerHTML = S.log.map(e => `<li><time>${esc(e.time)}</time>${esc(e.text)}</li>`).join('');
  }

  // ---------- characters ----------
  function blankCharacter() {
    const attrs = {}; ATTRS.forEach(([k]) => attrs[k] = 0);
    return normalizeCharacter({
      id: uid(), name: 'Novo Personagem', clazz:'', race:'', element:'', level:1, owner:'',
      hp:10,hpMax:10, mp:10,mpMax:10, san:10,sanMax:10, def:0,defMax:10,
      attrs, inventoryItems: [], inventoryLimit: 10, powers: [blankPower(),blankPower(),blankPower()], powerSlots: 3, notes:'', img:''
    });
  }
  function upsertCharacter(char, emit=true) {
    normalizeCharacter(char);
    const i = S.characters.findIndex(c => c.id === char.id);
    if (i >= 0) S.characters[i] = char; else S.characters.push(char);
    syncCharToTokens(char);
    if (emit) { log(`Ficha salva: ${char.name}.`); scheduleSave(); }
    renderCharacters(); renderCharForm(); renderTokens(); renderLinks(); renderRollAs();
  }
  function deleteCharacter(id) {
    const c = charById(id); if (!c) return;
    S.characters = S.characters.filter(x => x.id !== id);
    if (selectedCharId === id) selectedCharId = null;
    log(`Personagem removido: ${c.name}.`);
    scheduleSave(); renderAll();
  }
  function syncCharToTokens(c) {
    S.tokens.forEach(t => { if (t.charId === c.id) { t.name = c.name; t.img = c.img || t.img; t.hp = c.hp; t.hpMax = c.hpMax; t.owner = c.owner || t.owner; } });
  }

  function applyCharPatch(id, patch, who, emitToHost) {
    const c = charById(id); if (!c) return;
    if (me.role !== 'gm' && !canControlCharacter(c, who)) return;
    // allowed: current status adjustments, inventory edits within limit, power detail edits, notes
    if (patch.stats) {
      ['hp','mp','san','def'].forEach(k => {
        if (typeof patch.stats[k] === 'number') c[k] = clamp(patch.stats[k], 0, c[k+'Max'] || 0);
      });
    }
    if (patch.inventoryItems && Array.isArray(patch.inventoryItems)) {
      c.inventoryItems = patch.inventoryItems.slice(0, c.inventoryLimit || 0);
    }
    if (patch.notes != null) c.notes = String(patch.notes);
    if (patch.powers && Array.isArray(patch.powers)) {
      // players can edit power details for enabled slots
      for (let i=0;i<Math.min(c.powerSlots,3);i++) if (patch.powers[i]) c.powers[i] = Object.assign(c.powers[i], patch.powers[i]);
    }
    syncCharToTokens(c);
    if (me.role === 'gm') { scheduleSave(); renderAll(); }
    else if (emitToHost) { sendToHost({ t:'charPatch', id, patch, who: me.name }); }
  }

  function renderCharacters() {
    const ul = $('#charList'); if (!ul) return;
    const list = me.role === 'gm' ? S.characters : myCharacters();
    if (!list.length) { ul.innerHTML = `<li class="muted" style="cursor:default">${me.role==='gm'?'Nenhum personagem cadastrado.':'Nenhum personagem vinculado a você.'}</li>`; return; }
    ul.innerHTML = list.map(c => `
      <li data-id="${c.id}" class="${c.id===selectedCharId?'active':''}">
        <div><div><strong>${esc(c.name)}</strong></div><div class="meta">${esc(c.clazz||'—')} · Nv ${c.level||1} · ${esc(c.owner||'sem jogador')}</div></div>
        <span class="muted">›</span>
      </li>`).join('');
  }

  function statBarHtml(c, key, label, cls) {
    const cur = c[key], max = c[key+'Max'] || 0;
    const pct = max>0 ? clamp((cur/max)*100,0,100) : 0;
    const gmMax = me.role === 'gm' ? `<label style="margin-top:4px">Máx. (mestre) <input type="number" min="0" value="${max}" data-max-key="${key}"></label>` : '';
    return `<div class="stat-bar ${cls}" data-key="${key}">
      <header><span>${label}</span><span class="nums"><b data-val>${cur}</b> / ${max}</span></header>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      <div class="controls">
        <button type="button" class="btn small" data-delta="-5">-5</button>
        <button type="button" class="btn small" data-delta="-1">-1</button>
        <button type="button" class="btn small" data-delta="1">+1</button>
        <button type="button" class="btn small" data-delta="5">+5</button>
      </div>
      ${gmMax}
    </div>`;
  }

  function renderCharForm() {
    const empty = $('#sheetEmpty'), body = $('#sheetBody'), form = $('#charForm');
    const c = charById(selectedCharId);
    if (!c) { empty.classList.remove('hidden'); body.classList.add('hidden'); return; }
    const canEdit = me.role === 'gm' || canControlCharacter(c, me.name);
    empty.classList.add('hidden'); body.classList.remove('hidden');
    form.name.value = c.name||''; form.clazz.value=c.clazz||''; form.race.value=c.race||''; form.element.value=c.element||'';
    form.level.value=c.level||1; form.owner.value=c.owner||''; form.notes.value=c.notes||'';
    const p = $('#charPortrait'); p.style.backgroundImage = c.img ? `url("${c.img}")` : ''; p.textContent = c.img ? '' : 'Sem imagem';

    // status bars
    $('#statusBars').innerHTML = [
      statBarHtml(c,'hp','Vida','hp'),
      statBarHtml(c,'mp','Mana','mp'),
      statBarHtml(c,'san','Sanidade','san'),
      statBarHtml(c,'def','Defesa','def')
    ].join('');

    // attrs
    $('#attrGrid').innerHTML = ATTRS.map(([k,label])=>{
      const v = c.attrs[k]||0;
      return `<div class="attr"><header><span>${label}</span><button type="button" class="btn small ghost" data-roll-attr="${k}">Rolar d20</button></header>
        <input type="number" name="attr_${k}" value="${v}" ${me.role!=='gm'?'disabled':''}><small>Base definida pelo mestre: ${v}</small></div>`;
    }).join('');

    // inventory
    form.inventoryLimit.value = c.inventoryLimit;
    form.inventoryLimit.disabled = me.role !== 'gm';
    renderInventory(c);
    // powers
    form.powerSlots.value = String(c.powerSlots);
    form.powerSlots.disabled = me.role !== 'gm';
    renderPowers(c);

    // permissions
    $$('input[name="name"],input[name="clazz"],input[name="race"],input[name="element"],input[name="level"],input[name="owner"]', form).forEach(el=> el.disabled = me.role!=='gm');
    $('#btnAddItem').disabled = !canEdit || c.inventoryItems.length >= c.inventoryLimit;
  }

  function renderInventory(c) {
    const wrap = $('#inventoryList'); if (!wrap) return;
    $('#invCount').textContent = `${c.inventoryItems.length}/${c.inventoryLimit}`;
    if (c.inventoryLimit === 0) { wrap.innerHTML = `<div class="hint">Inventário desabilitado pelo mestre (limite 0).</div>`; $('#btnAddItem').disabled = true; return; }
    wrap.innerHTML = c.inventoryItems.map((it,i)=>`<div class="inv-item"><input data-inv="${i}" value="${esc(it)}" placeholder="Item ${i+1}"><button type="button" class="btn small ghost" data-del-inv="${i}">✕</button></div>`).join('') || `<div class="hint">Sem itens.</div>`;
    const canEdit = me.role==='gm' || canControlCharacter(c, me.name);
    $$('[data-inv],[data-del-inv]', wrap).forEach(el=> el.disabled = !canEdit);
  }

  function renderPowers(c) {
    const wrap = $('#powersList'); if (!wrap) return;
    const count = c.powerSlots;
    if (count === 0) { wrap.innerHTML = `<div class="hint">Nenhum poder definido pelo mestre.</div>`; return; }
    wrap.innerHTML = Array.from({length: count}, (_,i)=>{
      const p = c.powers[i] || blankPower();
      return `<div class="power-card" data-power="${i}">
        <h4>Poder ${i+1}</h4>
        <div class="power-grid">
          ${POWER_FIELDS.map(([k,label])=>`<label>${label}<input data-pk="${k}" value="${esc(p[k]||'')}"></label>`).join('')}
        </div>
        <label>Descrição <textarea data-pk="descricao" rows="2">${esc(p.descricao||'')}</textarea></label>
        <label>Efeito <textarea data-pk="efeito" rows="2">${esc(p.efeito||'')}</textarea></label>
      </div>`;
    }).join('');
    const canEdit = me.role==='gm' || canControlCharacter(c, me.name);
    $$('.power-card input,.power-card textarea', wrap).forEach(el=> el.disabled = !canEdit);
  }

  function readCharFormBase() {
    const c = charById(selectedCharId); if (!c) return null;
    const f = $('#charForm');
    if (me.role === 'gm') {
      c.name = f.name.value.trim() || c.name;
      c.clazz = f.clazz.value.trim(); c.race = f.race.value.trim(); c.element = f.element.value.trim();
      c.level = parseInt(f.level.value,10)||1; c.owner = f.owner.value.trim();
      c.inventoryLimit = Math.max(0, parseInt(f.inventoryLimit.value,10)||0);
      c.powerSlots = clamp(parseInt(f.powerSlots.value,10)||0,0,3);
      ATTRS.forEach(([k])=> c.attrs[k] = parseInt(f[`attr_${k}`].value,10)||0);
      // maxes
      $$('[data-max-key]').forEach(inp => { const k=inp.dataset.maxKey; c[k+'Max']=Math.max(0, parseInt(inp.value,10)||0); c[k]=clamp(c[k],0,c[k+'Max']); });
      c.inventoryItems = c.inventoryItems.slice(0, c.inventoryLimit);
    }
    c.notes = f.notes.value;
    // inventory/powers from DOM
    c.inventoryItems = $$('[data-inv]').map(i=>i.value.trim()).filter((v,idx,arr)=>!(v==='' && idx>=arr.length)); 
    c.inventoryItems = c.inventoryItems.filter(v=>v!=='').slice(0, c.inventoryLimit);
    $$('.power-card').forEach(card => {
      const i = +card.dataset.power; if (!c.powers[i]) c.powers[i]=blankPower();
      $$('[data-pk]', card).forEach(el => c.powers[i][el.dataset.pk] = el.value);
    });
    return c;
  }

  // ---------- tokens & map ----------
  function boardRect(){ return $('#board').getBoundingClientRect(); }
  function addToken(data) {
    const t = Object.assign({ id:uid(), name:'Token', x:50,y:50,size:1,color:'#a33',img:'',hp:10,hpMax:10,owner:'',charId:null,hidden:false,inInit:true,initMod:0,type:'npc' }, data||{});
    S.tokens.push(t); scheduleSave(); renderTokens(); renderTokenAdmin(); return t;
  }
  function tokenPixelSize(t){ const b=$('#board'); const cell=Math.min(b.clientWidth/S.map.cols,b.clientHeight/S.map.rows); return clamp(cell*(t.size||1)*0.9,28,140); }
  function renderTokens() {
    const layer = $('#tokenLayer'); if (!layer) return; layer.innerHTML='';
    S.tokens.forEach(t => {
      if (me.role!=='gm' && t.hidden) return;
      const el = document.createElement('div');
      el.className = 'token'+(t.hidden?' hidden-token':'');
      el.dataset.id = t.id;
      const px = tokenPixelSize(t);
      el.style.width=px+'px'; el.style.height=px+'px'; el.style.left=t.x+'%'; el.style.top=t.y+'%';
      el.style.backgroundColor=t.color||'#666'; if (t.img) el.style.backgroundImage=`url("${t.img}")`;
      const pct = t.hpMax>0 ? clamp((t.hp/t.hpMax)*100,0,100) : 0;
      el.innerHTML = `${t.img?'':`<span class="label">${esc((t.name||'?').slice(0,2).toUpperCase())}</span>`}<span class="hpbar"><i style="width:${pct}%"></i></span>`;
      if ((S.initiative.order||[])[S.initiative.index] === t.id) el.classList.add('selected');
      el.addEventListener('pointerdown', onTokenPointerDown);
      el.addEventListener('click', e=>{ if(me.role==='gm'){ e.stopPropagation(); openTokenModal(t.id);} });
      layer.appendChild(el);
    });
  }
  function onTokenPointerDown(e){
    const id=e.currentTarget.dataset.id; const t=S.tokens.find(x=>x.id===id); if(!t) return;
    if(!canControlToken(t)) return;
    e.preventDefault();
    drag={ id, startX:e.clientX, startY:e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onBoardPointerMove(e){
    if (painting && me.role==='gm') { paintFogAtEvent(e); return; }
    if (!drag) return;
    const t=S.tokens.find(x=>x.id===drag.id); if(!t) return;
    const rect=boardRect();
    t.x = clamp(t.x + ((e.clientX-drag.startX)/rect.width)*100, 0, 100);
    t.y = clamp(t.y + ((e.clientY-drag.startY)/rect.height)*100, 0, 100);
    drag.startX=e.clientX; drag.startY=e.clientY;
    const el=$(`.token[data-id="${t.id}"]`); if(el){ el.style.left=t.x+'%'; el.style.top=t.y+'%'; }
  }
  function onBoardPointerUp(){
    if (painting){ painting=false; scheduleSave(); return; }
    if (!drag) return; const t=S.tokens.find(x=>x.id===drag.id); drag=null;
    if (t){ if(me.role==='gm') scheduleSave(); else sendToHost({t:'tokenMove', id:t.id, x:t.x, y:t.y, who:me.name}); }
  }

  function renderMap(){ $('#mapLayer').style.backgroundImage = S.map.src ? `url("${S.map.src}")` : 'none'; drawGrid(); drawFog(); }
  function drawGrid(){
    const c=$('#gridCanvas'), b=$('#board'); if(!c||!b) return;
    c.width=b.clientWidth; c.height=b.clientHeight; const ctx=c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height);
    if(!$('#toggleGrid').checked) return;
    const cols=S.map.cols, rows=S.map.rows; ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1;
    for(let i=0;i<=cols;i++){ const x=(i/cols)*c.width; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,c.height); ctx.stroke(); }
    for(let j=0;j<=rows;j++){ const y=(j/rows)*c.height; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(c.width,y); ctx.stroke(); }
  }
  function fogKey(c,r){return c+','+r;}
  function isRevealed(c,r){ return S.fog.cells.includes(fogKey(c,r)); }
  function setRevealed(c,r,val){ const k=fogKey(c,r), i=S.fog.cells.indexOf(k); if(val && i<0) S.fog.cells.push(k); if(!val && i>=0) S.fog.cells.splice(i,1); }
  function drawFog(){
    const c=$('#fogCanvas'), b=$('#board'); if(!c||!b) return;
    c.width=b.clientWidth; c.height=b.clientHeight; const ctx=c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height);
    const cols=S.map.cols, rows=S.map.rows, cw=c.width/cols, ch=c.height/rows;
    ctx.fillStyle = me.role==='gm' ? 'rgba(20,8,10,0.55)' : 'rgba(8,3,5,0.96)';
    for(let y=0;y<rows;y++) for(let x=0;x<cols;x++) if(!isRevealed(x,y)) ctx.fillRect(x*cw,y*ch,cw+1,ch+1);
  }
  function paintFogAtEvent(e){
    const rect=boardRect(); const x=clamp(e.clientX-rect.left,0,rect.width-1), y=clamp(e.clientY-rect.top,0,rect.height-1);
    const col=Math.floor((x/rect.width)*S.map.cols), row=Math.floor((y/rect.height)*S.map.rows);
    setRevealed(col,row, $('#fogMode').value==='reveal'); drawFog();
  }
  function onBoardPointerDown(e){
    if(e.target.closest('.token')) return;
    if(me.role==='gm' && $('#fogPaint').checked){ painting=true; paintFogAtEvent(e); $('#board').setPointerCapture(e.pointerId); }
  }
  function coverAllFog(reveal){ S.fog.cells=[]; if(reveal){ for(let y=0;y<S.map.rows;y++) for(let x=0;x<S.map.cols;x++) S.fog.cells.push(fogKey(x,y)); } drawFog(); scheduleSave(); }

  // ---------- dice ----------
  function rollDie(sides){ return Math.floor(Math.random()*sides)+1; }
  function modFromAttr(score){ return Math.floor(((+score||0)-10)/2); } // classic mod; GM can set base to reflect system
  function spawnDieVisual(value, sides, who, totalText){
    const stage=$('#diceStage'); if(!stage) return;
    const d=document.createElement('div');
    d.className='die d'+sides+(sides===20&&value===20?' crit':'')+(sides===20&&value===1?' fumble':'');
    d.style.left=(30+Math.random()*40)+'%'; d.style.top=(35+Math.random()*30)+'%'; d.style.setProperty('--tx',(Math.random()*40-20).toFixed(0)+'px');
    d.innerHTML=`<span class="who">${esc(who||'Rolagem')}</span><span>${value}</span><span class="faces">d${sides}</span>${totalText?`<span class="total">${esc(totalText)}</span>`:''}`;
    stage.appendChild(d); setTimeout(()=>d.remove(), 3400);
  }
  function doRoll(die, qty, mod, who, label, attrMod, fromNet){
    qty=clamp(parseInt(qty)||1,1,10); mod=parseInt(mod)||0; attrMod=parseInt(attrMod)||0;
    const totalMod = mod + attrMod;
    const results=[]; for(let i=0;i<qty;i++) results.push(rollDie(die));
    const sum=results.reduce((a,b)=>a+b,0); const total=sum+totalMod;
    const totalText = (qty>1||totalMod)?`= ${total}`:'';
    results.forEach((v,i)=> setTimeout(()=>spawnDieVisual(v, die, who, i===results.length-1?totalText:''), i*120));
    const parts=[]; if(attrMod) parts.push(`atrib ${attrMod>=0?'+':''}${attrMod}`); if(mod) parts.push(`mod ${mod>=0?'+':''}${mod}`);
    const txt = `${who} rolou ${qty>1?qty+'×':''}d${die}${label?` (${label})`:''}${parts.length?` [${parts.join(', ')}]`:''}: [${results.join(', ')}]${(qty>1||totalMod)?` = ${total}`:''}`;
    addLog(txt,'roll',false);
    if(me.role==='gm'){ scheduleSave(); broadcastState(); }
    renderLog();
  }
  function requestRoll(die){
    const qty=$('#diceQty').value, extra=parseInt($('#diceMod').value,10)||0;
    const charId=$('#rollAs').value; const c=charById(charId);
    const attrKey=$('#rollAttr').value;
    let attrMod=0, label='', who=me.name||'Jogador';
    if(c){ who=c.name; if(attrKey && c.attrs){ attrMod = (c.attrs[attrKey]||0); label = (ATTRS.find(a=>a[0]===attrKey)||[])[1]||attrKey; } }
    else if(attrKey){ label = (ATTRS.find(a=>a[0]===attrKey)||[])[1]||attrKey; }
    if(me.role==='gm') doRoll(die, qty, extra, who, label, attrMod, false);
    else sendToHost({ t:'roll', die, qty, mod:extra, attrMod, who, label });
  }
  function renderRollAs(){
    const sel=$('#rollAs'); if(!sel) return;
    const list = me.role==='gm' ? S.characters : myCharacters();
    const prev=sel.value;
    sel.innerHTML = `<option value="">— ${me.role==='gm'?'Mestre/NPC':'Sem personagem'} —</option>` + list.map(c=>`<option value="${c.id}" ${c.id===prev?'selected':''}>${esc(c.name)}</option>`).join('');
  }

  // ---------- initiative ----------
  function rollInitiative(){
    const entries=[];
    S.tokens.forEach(t=>{
      if(t.hidden || t.inInit===false) return;
      let mod=+t.initMod||0; if(t.charId){ const c=charById(t.charId); if(c&&c.attrs) mod += (c.attrs.des||0); }
      const roll=rollDie(20); entries.push({id:t.id,name:t.name,roll,mod,total:roll+mod});
    });
    entries.sort((a,b)=>b.total-a.total);
    S.initiative={order:entries.map(e=>e.id),details:entries,index:entries.length?0:-1,round:1};
    log(`Iniciativa rolada (${entries.length}).`); scheduleSave(); renderInitiative(); renderTokens();
  }
  function nextTurn(){ const o=S.initiative.order||[]; if(!o.length) return; S.initiative.index++; if(S.initiative.index>=o.length){S.initiative.index=0; S.initiative.round=(S.initiative.round||1)+1; log(`Rodada ${S.initiative.round}.`);} const t=S.tokens.find(x=>x.id===o[S.initiative.index]); if(t) log(`Turno: ${t.name}.`,'turn'); scheduleSave(); renderInitiative(); renderTokens(); }
  function clearInitiative(){ S.initiative={order:[],details:[],index:-1,round:1}; log('Iniciativa limpa.'); scheduleSave(); renderInitiative(); renderTokens(); }
  function renderInitiative(){ const ol=$('#initList'), empty=$('#initEmpty'); const det=S.initiative.details||[]; if(!det.length){ ol.innerHTML=''; empty.classList.remove('hidden'); return;} empty.classList.add('hidden'); ol.innerHTML=det.map((e,i)=>`<li class="${i===S.initiative.index?'active':''}">${esc(e.name)} <span class="val">${e.total}</span> <span class="muted">(${e.roll}${e.mod? (e.mod>0?`+${e.mod}`:e.mod):''})</span></li>`).join(''); }

  // ---------- GM/admin ----------
  function renderTokenAdmin(){ const ul=$('#tokenList'); if(!ul) return; if(!S.tokens.length){ ul.innerHTML=`<li class="muted">Nenhum token.</li>`; return;} ul.innerHTML=S.tokens.map(t=>`<li><div><strong>${esc(t.name)}</strong> <span class="muted">PV ${t.hp}/${t.hpMax} ${t.hidden?'· oculto':''}</span></div><div class="actions"><button class="btn small" data-edit-token="${t.id}">Editar</button><button class="btn small ghost" data-del-token="${t.id}">✕</button></div></li>`).join(''); }
  function renderLibrary(){ const ul=$('#libraryList'); if(!ul) return; if(!S.library.length){ ul.innerHTML=`<li class="muted">Sem biblioteca importada.</li>`; return;} ul.innerHTML=S.library.map((n,i)=>`<li><div><strong>${esc(n.n||n.name)}</strong> <span class="muted">${n.hp?('PV '+n.hp):''}</span></div><div class="actions"><button class="btn small" data-lib="${i}">Colocar</button></div></li>`).join(''); }
  function renderLinks(){ const ul=$('#linkList'); if(!ul) return; if(!S.characters.length){ ul.innerHTML=`<li class="muted">Cadastre personagens para vincular jogadores.</li>`; return;} ul.innerHTML=S.characters.map(c=>`<li><div><strong>${esc(c.name)}</strong></div><div class="muted">${c.owner?`→ ${esc(c.owner)}`:'(sem vínculo)'}</div></li>`).join(''); }
  function openTokenModal(id){ const t=S.tokens.find(x=>x.id===id); if(!t) return; const form=$('#tokenForm'); form.dataset.id=id; form.innerHTML=`<label>Nome <input name="name" value="${esc(t.name)}"></label>
    <div class="grid2"><label>PV atual <input name="hp" type="number" value="${t.hp}"></label><label>PV máx <input name="hpMax" type="number" value="${t.hpMax}"></label>
    <label>Tamanho <input name="size" type="number" min="1" max="6" value="${t.size||1}"></label><label>Mod. iniciativa <input name="initMod" type="number" value="${t.initMod||0}"></label>
    <label>Cor <input name="color" type="color" value="${esc(t.color||'#a33')}"></label><label>Dono (jogador) <input name="owner" value="${esc(t.owner||'')}"></label></div>
    <div class="row wrap"><label class="toggle"><input type="checkbox" name="hidden" ${t.hidden?'checked':''}> Oculto</label><label class="toggle"><input type="checkbox" name="inInit" ${t.inInit!==false?'checked':''}> Iniciativa</label></div>
    <div class="row wrap"><button type="button" class="btn small" id="btnTokenImg">Imagem</button><button type="submit" class="btn primary">Salvar</button><button type="button" class="btn danger ghost" id="btnTokenDelete">Excluir</button></div>`;
    $('#modal').classList.remove('hidden');
    $('#btnTokenImg').onclick=()=>pickImage(512,src=>{t.img=src; scheduleSave(); renderTokens();});
    $('#btnTokenDelete').onclick=()=>{ S.tokens=S.tokens.filter(x=>x.id!==id); closeModal(); scheduleSave(); renderAll(); };
  }
  function closeModal(){ $('#modal').classList.add('hidden'); }

  function pickImage(max, cb){ const inp=$('#imagePicker'); inp.onchange=()=>{ const f=inp.files&&inp.files[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ const img=new Image(); img.onload=()=>{ let w=img.width,h=img.height; const s=Math.min(1,max/Math.max(w,h)); w=Math.round(w*s); h=Math.round(h*s); const cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h); cb(cv.toDataURL('image/jpeg',0.85)); }; img.src=r.result; }; r.readAsDataURL(f); inp.value=''; }; inp.click(); }
  async function loadBundledGrimoire(){ try{ const res=await fetch('grimoire-campanha.json',{cache:'no-store'}); if(!res.ok) return; const data=await res.json(); if(Array.isArray(data.npcs)) S.library=data.npcs; renderLibrary(); }catch{} }
  function importGrimoireFile(file){ const r=new FileReader(); r.onload=()=>{ try{ const data=JSON.parse(r.result); if(Array.isArray(data.npcs)) S.library=data.npcs; else if(Array.isArray(data)) S.library=data; if(Array.isArray(data.characters)) data.characters.forEach(c=>{ normalizeCharacter(c); const i=S.characters.findIndex(x=>x.id===c.id); if(i>=0)S.characters[i]=c; else S.characters.push(c); }); log('Grimoire importado.'); scheduleSave(); renderAll(); }catch{ alert('Arquivo inválido.'); } }; r.readAsText(file); }

  function renderAll(){
    document.body.classList.toggle('is-gm', me.role==='gm');
    $('#roomTitle').textContent = S.room ? `Sala ${S.room}` : 'Mesa local';
    $('#roomMeta').textContent = me.role==='gm' ? `Mestre: ${me.name}` : `Jogador: ${me.name}`;
    $('#gridCols').value=S.map.cols; $('#gridRows').value=S.map.rows;
    renderMap(); renderTokens(); renderInitiative(); renderLog(); renderCharacters(); renderCharForm(); renderTokenAdmin(); renderLibrary(); renderLinks(); renderRollAs();
  }

  function setConn(text, ok){ const b=$('#connBadge'); b.textContent=text; b.classList.toggle('ok', !!ok); }
  function startHost(room){ me.role='gm'; S.room=room||''; normalizeState(); if(S.fog.cells.length===0) coverAllFog(false); showApp(); renderAll(); saveLocal(); if(!room){ setConn('local',true); return; } setConn('abrindo...',false); peer=new Peer('kaka-'+room,{debug:0}); peer.on('open',()=>setConn('online',true)); peer.on('connection',c=>{ conns.push(c); c.on('open',()=>{ try{c.send({t:'state',s:playerView()});}catch{} }); c.on('data',msg=>handleMsg(msg,c)); c.on('close',()=>{ conns=conns.filter(x=>x!==c); log('Um jogador saiu.'); }); }); peer.on('error',err=>{ setConn('erro',false); alert('Erro: '+err.type); }); }
  function startJoin(room){ me.role='player'; S.room=room; normalizeState(); showApp(); setConn('conectando...',false); peer=new Peer(); peer.on('open',()=>{ hostConn=peer.connect('kaka-'+room,{reliable:true}); hostConn.on('open',()=>{ setConn('online',true); hostConn.send({t:'hello',name:me.name}); }); hostConn.on('data',msg=>handleMsg(msg,hostConn)); hostConn.on('close',()=>{ setConn('desconectado',false); log('Conexão perdida.'); }); hostConn.on('error',()=>setConn('erro',false)); }); peer.on('error',err=>{ setConn('erro',false); alert('Não foi possível conectar: '+err.type); }); }
  function showApp(){ $('#lobby').classList.add('hidden'); $('#app').classList.remove('hidden'); }

  function bind(){
    $('#btnHost').onclick=()=>{ me.name=$('#playerName').value.trim()||'Mestre'; startHost($('#roomCode').value.trim().toUpperCase()); };
    $('#btnJoin').onclick=()=>{ me.name=$('#playerName').value.trim()||'Jogador'; const room=$('#roomCode').value.trim().toUpperCase(); if(!room){ $('#lobbyMsg').textContent='Informe o código da sala.'; return; } startJoin(room); };
    $('#btnSolo').onclick=()=>{ me.name=$('#playerName').value.trim()||'Mestre'; startHost(''); };
    $('#btnLeave').onclick=()=>location.reload();

    $$('.tab').forEach(btn=>btn.addEventListener('click',()=>{ const view=btn.dataset.view; $$('.tab').forEach(b=>b.classList.toggle('active',b===btn)); $$('.view').forEach(v=>{ const on=v.id===view; v.hidden=!on; v.classList.toggle('active',on); }); if(view==='view-table') setTimeout(()=>{drawGrid();drawFog();renderTokens();},30); }));

    $$('.die-btn').forEach(b=>b.addEventListener('click',()=>requestRoll(parseInt(b.dataset.die,10))));
    $('#btnClearLog').onclick=()=>{ S.log=[]; renderLog(); if(me.role==='gm') scheduleSave(); };
    $('#btnRollInit').onclick=rollInitiative; $('#btnNextTurn').onclick=nextTurn; $('#btnClearInit').onclick=clearInitiative;

    const board=$('#board'); board.addEventListener('pointerdown', onBoardPointerDown); window.addEventListener('pointermove', onBoardPointerMove); window.addEventListener('pointerup', onBoardPointerUp);
    $('#toggleGrid').onchange=drawGrid; $('#btnFit').onclick=()=>{ drawGrid(); drawFog(); renderTokens(); }; window.addEventListener('resize',()=>{ drawGrid(); drawFog(); renderTokens(); });

    // characters
    $('#btnNewChar').onclick=()=>{ if(me.role!=='gm') return; const c=blankCharacter(); S.characters.push(c); selectedCharId=c.id; log(`Personagem cadastrado: ${c.name}.`); scheduleSave(); renderAll(); };
    $('#charList').onclick=e=>{ const li=e.target.closest('li[data-id]'); if(!li) return; selectedCharId=li.dataset.id; renderCharacters(); renderCharForm(); };
    $('#charForm').addEventListener('submit', e=>{
      e.preventDefault(); const c=readCharFormBase(); if(!c) return;
      if(me.role==='gm'){ upsertCharacter(c,true); }
      else { // player save sends patch
        sendToHost({ t:'charPatch', id:c.id, who:me.name, patch:{ inventoryItems:c.inventoryItems, notes:c.notes, powers:c.powers, stats:{hp:c.hp,mp:c.mp,san:c.san,def:c.def} } });
        log('Alterações enviadas ao mestre.');
      }
    });

    // status bar interactions (delegated)
    $('#statusBars').addEventListener('click', e=>{
      const btn=e.target.closest('[data-delta]'); if(!btn) return; const bar=e.target.closest('.stat-bar'); if(!bar) return;
      const c=charById(selectedCharId); if(!c) return; if(me.role!=='gm' && !canControlCharacter(c,me.name)) return;
      const k=bar.dataset.key; const delta=parseInt(btn.dataset.delta,10)||0;
      c[k]=clamp((c[k]||0)+delta, 0, c[k+'Max']||0);
      syncCharToTokens(c);
      if(me.role==='gm'){ scheduleSave(); renderAll(); } else { sendToHost({t:'charPatch', id:c.id, who:me.name, patch:{stats:{[k]:c[k]}}}); renderCharForm(); renderTokens(); }
    });
    $('#statusBars').addEventListener('input', e=>{
      const inp=e.target.closest('[data-max-key]'); if(!inp || me.role!=='gm') return; const c=charById(selectedCharId); if(!c) return;
      const k=inp.dataset.maxKey; c[k+'Max']=Math.max(0, parseInt(inp.value,10)||0); c[k]=clamp(c[k],0,c[k+'Max']); renderCharForm();
    });

    $('#attrGrid').addEventListener('click', e=>{
      const rb=e.target.closest('[data-roll-attr]'); if(!rb) return; const c=charById(selectedCharId); if(!c) return;
      const k=rb.dataset.rollAttr; const attrMod=c.attrs[k]||0; const label=(ATTRS.find(a=>a[0]===k)||[])[1]||k;
      if(me.role==='gm') doRoll(20,1,0,c.name,label,attrMod,false); else sendToHost({t:'roll',die:20,qty:1,mod:0,attrMod,who:c.name,label});
    });
    $('#btnCharImage').onclick=()=>{ if(me.role!=='gm') return; const c=charById(selectedCharId); if(!c) return; pickImage(512,src=>{ c.img=src; renderCharForm(); }); };
    $('#btnDeleteChar').onclick=()=>{ if(me.role!=='gm') return; if(selectedCharId && confirm('Excluir personagem?')) deleteCharacter(selectedCharId); };
    $('#btnCharToToken').onclick=()=>{ if(me.role!=='gm') return; const c=readCharFormBase()||charById(selectedCharId); if(!c) return; addToken({name:c.name,img:c.img,hp:c.hp,hpMax:c.hpMax,owner:c.owner,charId:c.id,color:'#c44',type:'pc'}); log(`Token criado: ${c.name}.`); };

    $('#btnAddItem').onclick=()=>{
      const c=charById(selectedCharId); if(!c) return; if(me.role!=='gm' && !canControlCharacter(c,me.name)) return;
      if(c.inventoryItems.length >= c.inventoryLimit){ alert('Limite de inventário atingido (definido pelo mestre).'); return; }
      c.inventoryItems.push(''); renderInventory(c); $('#btnAddItem').disabled = c.inventoryItems.length >= c.inventoryLimit;
    };
    $('#inventoryList').addEventListener('click', e=>{
      const b=e.target.closest('[data-del-inv]'); if(!b) return; const c=charById(selectedCharId); if(!c) return; if(me.role!=='gm' && !canControlCharacter(c,me.name)) return;
      c.inventoryItems.splice(+b.dataset.delInv,1); renderInventory(c); $('#btnAddItem').disabled = c.inventoryItems.length >= c.inventoryLimit;
    });

    $('#btnImportGrimoire').onclick=()=>$('#grimoireFile').click();
    $('#grimoireFile').onchange=e=>{ const f=e.target.files[0]; if(f) importGrimoireFile(f); e.target.value=''; };

    // GM panel
    $('#btnMapUpload').onclick=()=>pickImage(2000,src=>{ S.map.src=src; log('Mapa atualizado.'); scheduleSave(); renderMap(); });
    $('#btnMapClear').onclick=()=>{ S.map.src=''; log('Mapa removido.'); scheduleSave(); renderMap(); };
    $('#btnApplyGrid').onclick=()=>{ S.map.cols=clamp(+$('#gridCols').value||24,5,60); S.map.rows=clamp(+$('#gridRows').value||16,5,60); scheduleSave(); drawGrid(); drawFog(); renderTokens(); };
    $('#btnFogCover').onclick=()=>{ coverAllFog(false); log('Névoa coberta.'); };
    $('#btnFogReveal').onclick=()=>{ coverAllFog(true); log('Névoa revelada.'); };
    $('#btnAddEnemy').onclick=()=>{ addToken({name:'Inimigo',color:'#ff4d5a',type:'enemy'}); log('Inimigo adicionado.'); };
    $('#btnAddNpc').onclick=()=>{ addToken({name:'NPC',color:'#ff8a5c',type:'npc',inInit:false}); log('NPC adicionado.'); };
    $('#btnAddPlayers').onclick=()=>{ S.characters.forEach((c,i)=>{ if(S.tokens.some(t=>t.charId===c.id)) return; addToken({name:c.name,img:c.img,hp:c.hp,hpMax:c.hpMax,owner:c.owner,charId:c.id,color:'#c44',type:'pc',x:10+(i%8)*10,y:80}); }); log('Tokens de jogadores garantidos.'); renderTokens(); };

    $('#tokenList').onclick=e=>{ const ed=e.target.closest('[data-edit-token]'); const del=e.target.closest('[data-del-token]'); if(ed) openTokenModal(ed.dataset.editToken); if(del){ S.tokens=S.tokens.filter(t=>t.id!==del.dataset.delToken); scheduleSave(); renderAll(); } };
    $('#libraryList').onclick=e=>{ const b=e.target.closest('[data-lib]'); if(!b) return; const n=S.library[+b.dataset.lib]; if(!n) return; addToken({name:n.n||n.name||'Criatura',hp:n.hp||10,hpMax:n.hp||10,hidden:true,inInit:!!n.hp,type:'npc',color:'#ff8a5c'}); log(`Criatura: ${n.n||n.name}.`); };

    $('#modal').addEventListener('click', e=>{ if(e.target.dataset.close) closeModal(); });
    $('#tokenForm').addEventListener('submit', e=>{ e.preventDefault(); const id=e.target.dataset.id; const t=S.tokens.find(x=>x.id===id); if(!t) return; const f=e.target; t.name=f.name.value; t.hp=+f.hp.value||0; t.hpMax=+f.hpMax.value||1; t.size=clamp(+f.size.value||1,1,6); t.initMod=+f.initMod.value||0; t.color=f.color.value; t.owner=f.owner.value.trim(); t.hidden=f.hidden.checked; t.inInit=f.inInit.checked; if(t.charId){ const c=charById(t.charId); if(c){ c.hp=t.hp; c.hpMax=t.hpMax; c.name=t.name; syncCharToTokens(c);} } closeModal(); scheduleSave(); renderAll(); });
  }

  function init(){ normalizeState(); bind(); loadBundledGrimoire(); renderAll(); }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();