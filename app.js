/* KAKA RPG — v4
   - Landing page + lobby
   - Múltiplos mapas/ambientes (com névoa própria)
   - Modos Jogar / Editor (mestre)
   - Falha crítica global em 1 natural no d20
   - Magos com até 4 poderes; demais até 3
   - Mapa em tela cheia, tokens com retrato inteiro
   - Otimizações: canvas de névoa offscreen, cache de imagem, rAF, saves debounced
*/
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const nowTime = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const normName = (s) => String(s || '').trim().toLowerCase();

  const ATTRS = [
    ['for', 'Força'], ['des', 'Destreza'], ['con', 'Constituição'],
    ['int', 'Inteligência'], ['sab', 'Sabedoria'], ['car', 'Carisma']
  ];
  const POWER_FIELDS = [
    ['nome', 'Nome'], ['gasto', 'Gasto'], ['elemento', 'Elemento'], ['tipoDano', 'Tipo de dano'],
    ['tempo', 'Tempo de conjuração'], ['alcance', 'Alcance'], ['componentes', 'Componentes (V/S/M)'],
    ['duracao', 'Duração'], ['dados', 'Dados / Dificuldade']
  ];

  const defaultState = () => ({
    version: 4, room: '', mode: 'edit',
    maps: [], activeMapId: null,
    tokens: [], characters: [], library: [],
    initiative: { order: [], details: [], index: -1, round: 1 }, log: []
  });

  let S = loadLocal() || defaultState();
  let me = { name: '', role: 'player' };
  let peer = null, hostConn = null, conns = [];
  let selectedCharId = null;
  let painting = false, lastPaint = null, drag = null, saveTimer = null;
  let suppressTokenClick = false;
  let layoutFrame = 0, fumbleTimer = null, toastTimer = null, joinTimer = null;
  let quotaWarned = false;

  /* =====================================================================
     STORAGE
     ===================================================================== */
  function storageKey() { return 'kakarpg_' + (S.room || 'local'); }

  function loadLocal() {
    try {
      const raw = localStorage.getItem('kakarpg_local') || localStorage.getItem('adb_mesa_local');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function saveLocal() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(S));
    } catch {
      if (!quotaWarned) {
        quotaWarned = true;
        toast('Armazenamento cheio. Reduza o tamanho das imagens dos mapas.');
      }
    }
  }

  function scheduleSave(immediate = false) {
    clearTimeout(saveTimer);
    const fn = () => { saveLocal(); if (me.role === 'gm') broadcastState(); };
    if (immediate) fn(); else saveTimer = setTimeout(fn, 260);
  }

  /* =====================================================================
     NORMALIZAÇÃO / MIGRAÇÃO
     ===================================================================== */
  function blankPower() {
    return { nome: '', gasto: '', descricao: '', elemento: '', tipoDano: '', tempo: '', alcance: '', componentes: '', duracao: '', efeito: '', dados: '' };
  }

  function maxPowerSlots(c) {
    return /m[aá]g/i.test(String((c && c.clazz) || '')) ? 4 : 3;
  }

  function normalizeCharacter(c) {
    c = c || {};
    c.id = c.id || uid();
    c.name = c.name || 'Novo Personagem';
    c.clazz = c.clazz || '';
    c.race = c.race || '';
    c.element = c.element || '';
    c.level = parseInt(c.level, 10) || 1;
    c.owner = c.owner || '';
    c.img = c.img || '';
    c.notes = c.notes || '';
    c.attrs = c.attrs || {};
    ATTRS.forEach(([k]) => { if (typeof c.attrs[k] !== 'number') c.attrs[k] = parseInt(c.attrs[k], 10) || 0; });
    ['hp', 'mp', 'san', 'def'].forEach(b => {
      const mk = b + 'Max';
      if (typeof c[mk] !== 'number') c[mk] = parseInt(c[mk], 10) || 10;
      c[mk] = Math.max(0, c[mk]);
      if (typeof c[b] !== 'number') c[b] = parseInt(c[b], 10);
      if (!Number.isFinite(c[b])) c[b] = c[mk];
      c[b] = clamp(c[b], 0, c[mk]);
    });
    c.inventoryLimit = Math.max(0, parseInt(c.inventoryLimit ?? 10, 10) || 0);
    if (!Array.isArray(c.inventoryItems)) {
      c.inventoryItems = (typeof c.inventory === 'string' && c.inventory.trim())
        ? c.inventory.split(/\n|,/).map(s => s.trim()).filter(Boolean)
        : [];
    }
    const maxP = maxPowerSlots(c);
    c.powerSlots = clamp(parseInt(c.powerSlots ?? 3, 10) || 0, 0, maxP);
    if (!Array.isArray(c.powers)) c.powers = [];
    while (c.powers.length < 4) c.powers.push(blankPower());
    c.powers = c.powers.slice(0, 4).map(p => Object.assign(blankPower(), p || {}));
    return c;
  }

  function normalizeMap(m, i) {
    m = m || {};
    m.id = m.id || uid();
    m.name = String(m.name || `Ambiente ${i + 1}`).trim() || `Ambiente ${i + 1}`;
    m.src = typeof m.src === 'string' ? m.src : '';
    m.cols = clamp(parseInt(m.cols, 10) || 24, 5, 80);
    m.rows = clamp(parseInt(m.rows, 10) || 16, 5, 80);
    m.fogImage = m.fogImage || null;
    m.fogCovered = !!m.fogCovered;
    return m;
  }

  function normalizeToken(t) {
    t = t || {};
    t.id = t.id || uid();
    t.name = t.name || 'Token';
    t.x = clamp(Number(t.x), 0, 100); if (!Number.isFinite(t.x)) t.x = 50;
    t.y = clamp(Number(t.y), 0, 100); if (!Number.isFinite(t.y)) t.y = 50;
    t.size = clamp(parseInt(t.size, 10) || 1, 1, 6);
    t.color = t.color || '#a33';
    t.img = t.img || '';
    t.owner = t.owner || '';
    t.charId = t.charId || null;
    t.hidden = !!t.hidden;
    t.inInit = t.inInit !== false;
    t.initMod = Number(t.initMod) || 0;
    t.type = t.type || 'npc';
    t.hpMax = Math.max(1, Number(t.hpMax) || 10);
    t.hp = Number.isFinite(Number(t.hp)) ? clamp(Number(t.hp), 0, t.hpMax) : t.hpMax;
    if (!S || !Array.isArray(S.maps) || !S.maps.some(m => m.id === t.mapId)) t.mapId = S && S.activeMapId;
    return t;
  }

  function normalizeState() {
    const legacyMap = S && S.map;
    const legacyFog = S && S.fogImage;
    const legacyCovered = S && S.fogCovered;
    const d = defaultState();
    S = Object.assign(d, S || {});

    if (!Array.isArray(S.maps) || !S.maps.length) {
      S.maps = [normalizeMap({
        id: uid(), name: 'Ambiente 1',
        src: (legacyMap && legacyMap.src) || '',
        cols: legacyMap && legacyMap.cols, rows: legacyMap && legacyMap.rows,
        fogImage: legacyFog || null, fogCovered: !!legacyCovered
      }, 0)];
    }
    S.maps = S.maps.map((m, i) => normalizeMap(m, i));
    if (!S.maps.some(m => m.id === S.activeMapId)) S.activeMapId = S.maps[0].id;

    S.mode = S.mode === 'play' ? 'play' : 'edit';
    S.characters = Array.isArray(S.characters) ? S.characters.map(normalizeCharacter) : [];
    S.tokens = Array.isArray(S.tokens) ? S.tokens.map(normalizeToken) : [];
    S.library = Array.isArray(S.library) ? S.library : [];
    S.log = Array.isArray(S.log) ? S.log : [];
    S.initiative = Object.assign(d.initiative, S.initiative || {});
    if (!Array.isArray(S.initiative.order)) S.initiative.order = [];
    if (!Array.isArray(S.initiative.details)) S.initiative.details = [];

    delete S.map; delete S.fogImage; delete S.fogCovered;
  }

  function activeMap() {
    return S.maps.find(m => m.id === S.activeMapId) || S.maps[0] || null;
  }

  function tokensOnActiveMap() {
    const m = activeMap();
    return m ? S.tokens.filter(t => t.mapId === m.id) : [];
  }

  /* =====================================================================
     REDE
     ===================================================================== */
  function playerView() {
    const v = JSON.parse(JSON.stringify(S));
    v.tokens = v.tokens.filter(t => !t.hidden);
    return v;
  }

  function broadcastToPlayers(payload) {
    if (me.role !== 'gm') return;
    const data = JSON.stringify(payload);
    conns.forEach(c => { if (c && c.open) { try { c.send(data); } catch { } } });
  }

  function broadcastState() { broadcastToPlayers({ t: 'state', s: playerView() }); }
  function sendToHost(msg) {
    if (!hostConn || !hostConn.open) return;
    try { hostConn.send(JSON.stringify(msg)); } catch { }
  }

  function handleMsg(raw, conn) {
    if (!raw) return;
    let msg = raw;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch { return; }
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'state' && me.role === 'player') {
      S = msg.s; normalizeState(); renderAll(); return;
    }
    if (msg.t === 'rollFx') { playRollFx(msg.die, msg.results, msg.who, msg.totalText); return; }
    if (msg.t === 'fumble') { showCriticalFailure(msg.name, false); return; }
    if (me.role !== 'gm') return;

    if (msg.t === 'hello') {
      if (conn) conn.nick = String(msg.name || '').trim();
      addLog(`${msg.name || 'Jogador'} entrou na mesa.`, 'info', false);
      broadcastState();
    } else if (msg.t === 'roll') {
      doRoll(msg.die, msg.qty || 1, msg.mod || 0, senderLabel(msg, conn), msg.label || '', msg.attrMod || 0);
    } else if (msg.t === 'tokenMove') {
      const tok = S.tokens.find(x => x.id === msg.id);
      const who = (conn && conn.nick) || msg.who;
      if (tok && ownsToken(tok, who)) {
        tok.x = clamp(Number(msg.x) || 0, 0, 100);
        tok.y = clamp(Number(msg.y) || 0, 0, 100);
        scheduleSave(); renderTokens();
      }
    } else if (msg.t === 'charPatch') {
      applyCharPatch(msg.id, msg.patch, (conn && conn.nick) || msg.who, false);
    } else if (msg.t === 'log') {
      addLog(String(msg.text || '').slice(0, 300), msg.kind, false); broadcastState();
    }
  }

  function senderLabel(msg, conn) {
    const sender = normName(conn && conn.nick);
    if (!sender) return String(msg.who || '').trim() || 'Jogador';
    const who = String(msg.who || '').trim();
    if (!who || normName(who) === sender) return who || (conn && conn.nick) || 'Jogador';
    const c = S.characters.find(ch => normName(ch.name) === normName(who));
    if (c && ownsCharacter(c, sender)) return c.name;
    return (conn && conn.nick) || 'Jogador';
  }

  /* =====================================================================
     PERMISSÕES
     ===================================================================== */
  function structureEditable() { return me.role === 'gm' && S.mode !== 'play'; }

  function requireEdit() {
    if (me.role !== 'gm') { toast('Somente o mestre pode editar a mesa.'); return false; }
    if (S.mode === 'play') { toast('Ative o Modo Editor para alterar a mesa.'); return false; }
    return true;
  }

  function ownsCharacter(c, who) {
    if (!c) return false;
    const n = normName(who);
    return !!n && normName(c.owner) === n;
  }

  function ownsToken(tok, who) {
    if (!tok) return false;
    const n = normName(who);
    if (!n) return false;
    if (normName(tok.owner) === n) return true;
    return ownsCharacter(S.characters.find(ch => ch.id === tok.charId), n);
  }

  function canControlCharacter(c, who) {
    if (!c) return false;
    if (me.role === 'gm') return true;
    return ownsCharacter(c, who || me.name);
  }

  function canControlToken(tok, who) {
    if (me.role === 'gm') return true;
    return ownsToken(tok, who || me.name);
  }

  function charById(id) { return S.characters.find(c => c.id === id); }
  function myCharacters() {
    if (me.role === 'gm') return S.characters;
    const n = normName(me.name);
    return S.characters.filter(c => normName(c.owner) === n);
  }

  /* =====================================================================
     LOG
     ===================================================================== */
  function addLog(text, kind = 'info', emit = true) {
    S.log.unshift({ id: uid(), text, kind, time: nowTime() });
    S.log = S.log.slice(0, 140);
    renderLog();
    if (emit) { if (me.role === 'gm') scheduleSave(); else sendToHost({ t: 'log', text, kind }); }
  }
  function log(text, kind = 'info') { addLog(text, kind, true); }
  function renderLog() {
    const ul = $('#logList'); if (!ul) return;
    ul.innerHTML = S.log.map(e => `<li><time>${esc(e.time)}</time>${esc(e.text)}</li>`).join('');
  }

  /* =====================================================================
     PERSONAGENS
     ===================================================================== */
  function blankCharacter() {
    const attrs = {}; ATTRS.forEach(([k]) => attrs[k] = 0);
    return normalizeCharacter({
      id: uid(), name: 'Novo Personagem', clazz: '', race: '', element: '', level: 1, owner: '',
      hp: 10, hpMax: 10, mp: 10, mpMax: 10, san: 10, sanMax: 10, def: 0, defMax: 10,
      attrs, inventoryItems: [], inventoryLimit: 10,
      powers: [blankPower(), blankPower(), blankPower(), blankPower()], powerSlots: 3,
      notes: '', img: ''
    });
  }

  function upsertCharacter(char, announce = true) {
    normalizeCharacter(char);
    const i = S.characters.findIndex(c => c.id === char.id);
    if (i >= 0) S.characters[i] = char; else S.characters.push(char);
    syncCharToTokens(char);
    if (announce) log(`Personagem salvo: ${char.name}.`);
    scheduleSave(true);
    renderCharacters(); renderCharForm(); renderTokens(); renderLinks(); renderRollAs(); renderTokenAdmin();
  }

  function deleteCharacter(id) {
    const c = charById(id); if (!c) return;
    S.characters = S.characters.filter(x => x.id !== id);
    S.tokens = S.tokens.filter(t => t.charId !== id);
    if (selectedCharId === id) selectedCharId = null;
    log(`Personagem removido: ${c.name}.`);
    scheduleSave(true);
    renderAll();
  }

  function syncCharToTokens(c) {
    S.tokens.forEach(t => {
      if (t.charId === c.id) {
        t.name = c.name;
        if (c.img) t.img = c.img;
        t.hp = c.hp; t.hpMax = c.hpMax;
        t.owner = c.owner || '';
      }
    });
  }

  function applyCharPatch(id, patch, who, emitToHost) {
    const c = charById(id); if (!c) return;
    if (!ownsCharacter(c, who)) return;
    if (patch.stats) {
      ['hp', 'mp', 'san', 'def'].forEach(k => {
        if (typeof patch.stats[k] === 'number') c[k] = clamp(patch.stats[k], 0, c[k + 'Max'] || 0);
      });
    }
    if (Array.isArray(patch.inventoryItems)) c.inventoryItems = patch.inventoryItems.slice(0, c.inventoryLimit || 0).map(v => String(v).slice(0, 120));
    if (patch.notes != null) c.notes = String(patch.notes).slice(0, 4000);
    if (Array.isArray(patch.powers)) {
      const max = Math.min(c.powerSlots, maxPowerSlots(c));
      for (let i = 0; i < max; i++) {
        if (patch.powers[i]) c.powers[i] = Object.assign(blankPower(), patch.powers[i]);
      }
    }
    syncCharToTokens(c);
    if (me.role === 'gm') { scheduleSave(); renderAll(); }
    else if (emitToHost) sendToHost({ t: 'charPatch', id, patch, who: me.name });
  }
  /* =====================================================================
     RENDER — PERSONAGENS
     ===================================================================== */
  function renderCharacters() {
    const ul = $('#charList'); if (!ul) return;
    const list = me.role === 'gm' ? S.characters : myCharacters();
    if (!list.length) {
      ul.innerHTML = `<li class="muted" style="cursor:default">${me.role === 'gm' ? 'Nenhum personagem cadastrado ainda.' : 'Nenhum personagem vinculado ao seu nick.'}</li>`;
      return;
    }
    ul.innerHTML = list.map(c => `
      <li data-id="${c.id}" class="${c.id === selectedCharId ? 'active' : ''}">
        <div>
          <div><strong>${esc(c.name)}</strong></div>
          <div class="meta">${esc(c.clazz || '—')} · Nv ${c.level || 1} · ${esc(c.owner || 'sem vínculo')}</div>
        </div>
        <span class="muted">›</span>
      </li>`).join('');
  }

  function statBarHtml(c, key, label, cls) {
    const cur = c[key], max = c[key + 'Max'] || 0;
    const pct = max > 0 ? clamp((cur / max) * 100, 0, 100) : 0;
    const gmMax = me.role === 'gm'
      ? `<label class="edit-only" style="margin-top:4px">Máx. (mestre)<input type="number" min="0" value="${max}" data-max-key="${key}" ${structureEditable() ? '' : 'disabled'}></label>`
      : '';
    return `<div class="stat-bar ${cls}" data-key="${key}">
      <header><span>${label}</span><span class="nums"><b data-val>${cur}</b> / ${max}</span></header>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      <div class="controls">
        <button type="button" class="btn small" data-delta="-5">-5</button>
        <button type="button" class="btn small" data-delta="-1">-1</button>
        <button type="button" class="btn small" data-delta="1">+1</button>
        <button type="button" class="btn small" data-delta="5">+5</button>
      </div>${gmMax}</div>`;
  }

  function fillPowerOptions(sel, value, max) {
    if (!sel) return;
    sel.innerHTML = Array.from({ length: max + 1 }, (_, i) => `<option value="${i}">${i}</option>`).join('');
    sel.value = String(clamp(parseInt(value, 10) || 0, 0, max));
  }

  function renderCharForm() {
    const empty = $('#sheetEmpty'), body = $('#sheetBody'), form = $('#charForm');
    if (!empty || !body || !form) return;
    const c = charById(selectedCharId);
    if (!c || (me.role !== 'gm' && !canControlCharacter(c, me.name))) {
      empty.classList.remove('hidden'); body.classList.add('hidden'); return;
    }
    empty.classList.add('hidden'); body.classList.remove('hidden');

    const gmEditing = structureEditable();
    form.name.value = c.name || '';
    form.clazz.value = c.clazz || '';
    form.race.value = c.race || '';
    form.element.value = c.element || '';
    form.level.value = c.level || 1;
    form.owner.value = c.owner || '';
    form.notes.value = c.notes || '';

    const p = $('#charPortrait');
    if (p) {
      p.style.backgroundImage = c.img ? `url("${c.img}")` : '';
      p.textContent = c.img ? '' : 'Sem imagem';
    }

    $('#statusBars').innerHTML = [
      statBarHtml(c, 'hp', 'Vida', 'hp'), statBarHtml(c, 'mp', 'Mana', 'mp'),
      statBarHtml(c, 'san', 'Sanidade', 'san'), statBarHtml(c, 'def', 'Defesa', 'def')
    ].join('');

    $('#attrGrid').innerHTML = ATTRS.map(([k, label]) => {
      const v = c.attrs[k] || 0;
      return `<div class="attr">
        <header><span>${label}</span><button type="button" class="btn small ghost" data-roll-attr="${k}">Rolar</button></header>
        <input type="number" name="attr_${k}" value="${v}" ${gmEditing ? '' : 'disabled'}>
        <small>Base: ${v}</small>
      </div>`;
    }).join('');

    const maxP = maxPowerSlots(c);
    fillPowerOptions(form.powerSlots, c.powerSlots, maxP);
    const powerLabel = $('#powerMaxLabel');
    if (powerLabel) powerLabel.textContent = maxP === 4 ? 'máx. 4 (mago)' : 'máx. 3';

    form.inventoryLimit.value = c.inventoryLimit;
    form.inventoryLimit.disabled = !gmEditing;
    form.powerSlots.disabled = !gmEditing;

    $$('input[name="name"],input[name="clazz"],input[name="race"],input[name="element"],input[name="level"],input[name="owner"]', form)
      .forEach(el => { el.disabled = !gmEditing; });

    renderInventory(c);
    renderPowers(c);
    const addBtn = $('#btnAddItem');
    if (addBtn) addBtn.disabled = !(me.role === 'gm' || canControlCharacter(c, me.name)) || c.inventoryItems.length >= c.inventoryLimit;
  }

  function renderInventory(c) {
    const wrap = $('#inventoryList'); if (!wrap) return;
    const count = $('#invCount'); if (count) count.textContent = `${c.inventoryItems.length}/${c.inventoryLimit}`;
    if (c.inventoryLimit === 0) { wrap.innerHTML = `<div class="hint">Inventário desabilitado (limite 0).</div>`; return; }
    wrap.innerHTML = c.inventoryItems.map((it, i) => `
      <div class="inv-item">
        <input data-inv="${i}" value="${esc(it)}" placeholder="Item ${i + 1}">
        <button type="button" class="btn small ghost" data-del-inv="${i}">✕</button>
      </div>`).join('') || `<div class="hint">Sem itens.</div>`;
    const canEdit = me.role === 'gm' || canControlCharacter(c, me.name);
    $$('[data-inv],[data-del-inv]', wrap).forEach(el => { el.disabled = !canEdit; });
  }

  function renderPowers(c) {
    const wrap = $('#powersList'); if (!wrap) return;
    const count = c.powerSlots;
    if (count === 0) { wrap.innerHTML = `<div class="hint">Nenhum poder (o mestre definiu 0).</div>`; return; }
    wrap.innerHTML = Array.from({ length: count }, (_, i) => {
      const p = c.powers[i] || blankPower();
      return `<div class="power-card" data-power="${i}">
        <h4>Poder ${i + 1}</h4>
        <div class="power-grid">
          ${POWER_FIELDS.map(([k, label]) => `<label>${label}<input data-pk="${k}" value="${esc(p[k] || '')}"></label>`).join('')}
        </div>
        <label>Descrição<textarea data-pk="descricao" rows="2">${esc(p.descricao || '')}</textarea></label>
        <label>Efeito<textarea data-pk="efeito" rows="2">${esc(p.efeito || '')}</textarea></label>
      </div>`;
    }).join('');
    const canEdit = me.role === 'gm' ? structureEditable() : canControlCharacter(c, me.name);
    $$('.power-card input,.power-card textarea', wrap).forEach(el => { el.disabled = !canEdit; });
  }

  function readCharFormBase() {
    const c = charById(selectedCharId); if (!c) return null;
    const f = $('#charForm');
    if (me.role === 'gm' && structureEditable()) {
      c.name = f.name.value.trim() || c.name;
      c.clazz = f.clazz.value.trim();
      c.race = f.race.value.trim();
      c.element = f.element.value.trim();
      c.level = parseInt(f.level.value, 10) || 1;
      c.owner = f.owner.value.trim();
      c.inventoryLimit = Math.max(0, parseInt(f.inventoryLimit.value, 10) || 0);
      c.powerSlots = clamp(parseInt(f.powerSlots.value, 10) || 0, 0, maxPowerSlots(c));
      ATTRS.forEach(([k]) => { c.attrs[k] = parseInt(f[`attr_${k}`].value, 10) || 0; });
      $$('[data-max-key]').forEach(inp => {
        const k = inp.dataset.maxKey;
        c[k + 'Max'] = Math.max(0, parseInt(inp.value, 10) || 0);
        c[k] = clamp(c[k], 0, c[k + 'Max']);
      });
    }
    if (me.role === 'gm' || canControlCharacter(c, me.name)) {
      c.notes = f.notes.value;
      c.inventoryItems = $$('[data-inv]').map(i => i.value.trim()).filter(v => v !== '').slice(0, c.inventoryLimit);
      $$('.power-card').forEach(card => {
        const i = +card.dataset.power;
        if (!c.powers[i]) c.powers[i] = blankPower();
        $$('[data-pk]', card).forEach(el => { c.powers[i][el.dataset.pk] = el.value; });
      });
    }
    return c;
  }

  /* =====================================================================
     RENDER — MAPAS
     ===================================================================== */
  function renderMapSelect() {
    const sel = $('#mapSelect'); if (!sel) return;
    sel.innerHTML = S.maps.map(m => `<option value="${esc(m.id)}" ${m.id === S.activeMapId ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  }

  function renderMapList() {
    const ul = $('#mapList'); if (!ul) return;
    ul.innerHTML = S.maps.map(m => `
      <li class="${m.id === S.activeMapId ? 'active' : ''}">
        <div class="map-thumb" style="${m.src ? `background-image:url('${m.src}')` : ''}"></div>
        <div class="map-info">
          <strong>${esc(m.name)}</strong>
          <span class="muted">${m.cols}×${m.rows}${m.src ? ' · com imagem' : ' · sem imagem'}${m.fogImage || m.fogCovered ? ' · névoa' : ''}</span>
        </div>
        <div class="actions">
          <button type="button" class="btn small ${m.id === S.activeMapId ? 'primary' : ''}" data-activate-map="${m.id}">${m.id === S.activeMapId ? 'Ativo' : 'Usar'}</button>
          <button type="button" class="btn small ghost" data-rename-map="${m.id}" title="Renomear">✎</button>
          <button type="button" class="btn small ghost" data-del-map="${m.id}" title="Excluir">✕</button>
        </div>
      </li>`).join('');
  }

  function setActiveMap(id) {
    const m = S.maps.find(x => x.id === id); if (!m) return;
    if (S.activeMapId === id) return;
    S.activeMapId = id;
    fogMaskMap = null; fogMaskSrc = null;
    log(`Ambiente ativo: ${m.name}.`);
    scheduleSave(true);
    renderAll();
  }

  function createMap() {
    if (!requireEdit()) return;
    const input = $('#mapNameInput');
    const name = (input && input.value.trim()) || `Ambiente ${S.maps.length + 1}`;
    const m = normalizeMap({ id: uid(), name, cols: 24, rows: 16 }, S.maps.length);
    S.maps.push(m);
    S.activeMapId = m.id;
    fogMaskMap = null; fogMaskSrc = null;
    if (input) input.value = '';
    log(`Novo ambiente: ${m.name}.`);
    scheduleSave(true);
    renderAll();
    pickImage(1600, src => {
      m.src = src;
      log(`Imagem do ambiente ${m.name} atualizada.`);
      scheduleSave(true);
      renderMap(); renderMapList(); renderMapSelect();
    });
  }

  function deleteMap(id) {
    if (!requireEdit()) return;
    const m = S.maps.find(x => x.id === id); if (!m) return;
    if (S.maps.length <= 1) {
      m.name = 'Ambiente 1'; m.src = ''; m.fogImage = null; m.fogCovered = false;
      S.tokens = S.tokens.filter(t => t.mapId !== m.id);
      fogMaskMap = null; fogMaskSrc = null;
      log('Ambiente reiniciado.');
      scheduleSave(true); renderAll(); return;
    }
    if (!confirm(`Excluir o ambiente "${m.name}" e os tokens dele?`)) return;
    S.tokens = S.tokens.filter(t => t.mapId !== id);
    S.maps = S.maps.filter(x => x.id !== id);
    if (S.activeMapId === id) S.activeMapId = S.maps[0].id;
    fogMaskMap = null; fogMaskSrc = null;
    log(`Ambiente removido: ${m.name}.`);
    scheduleSave(true);
    renderAll();
  }

  function renameMap(id) {
    if (!requireEdit()) return;
    const m = S.maps.find(x => x.id === id); if (!m) return;
    const name = prompt('Nome do ambiente:', m.name);
    if (name == null) return;
    m.name = name.trim() || m.name;
    log(`Ambiente renomeado: ${m.name}.`);
    scheduleSave(true);
    renderAll();
  }

  function applyGrid() {
    if (!requireEdit()) return;
    const m = activeMap(); if (!m) return;
    m.cols = clamp(parseInt($('#gridCols').value, 10) || 24, 5, 80);
    m.rows = clamp(parseInt($('#gridRows').value, 10) || 16, 5, 80);
    log(`Grade de ${m.name}: ${m.cols}×${m.rows}.`);
    scheduleSave(true);
    layoutBoard(); renderMapList();
  }

  /* =====================================================================
     TABULEIRO / TOKENS
     ===================================================================== */
  function boardRect() {
    const b = $('#board');
    return b ? b.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
  }

  function requestLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layoutBoard(); });
  }

  function layoutBoard() {
    const b = $('#board');
    if (!b || !b.clientWidth || !b.clientHeight) return;
    drawGrid(); drawFog(); renderTokens();
  }

  function renderMap() {
    const m = activeMap();
    const layer = $('#mapLayer');
    if (layer) layer.style.backgroundImage = m && m.src ? `url("${m.src}")` : 'none';
    drawGrid(); drawFog();
  }

  function drawGrid() {
    const c = $('#gridCanvas'), b = $('#board');
    if (!c || !b) return;
    const w = b.clientWidth, h = b.clientHeight;
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const toggle = $('#toggleGrid');
    if (toggle && !toggle.checked) return;
    const m = activeMap(); if (!m) return;
    const cols = m.cols, rows = m.rows;
    ctx.strokeStyle = 'rgba(255,255,255,0.11)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= cols; i++) {
      const x = Math.round((i / cols) * w) + .5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      const y = Math.round((j / rows) * h) + .5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  function tokenPixelSize(t) {
    const b = $('#board'); const m = activeMap();
    if (!b || !m) return 48;
    const cell = Math.min(b.clientWidth / m.cols, b.clientHeight / m.rows);
    return clamp(cell * (t.size || 1) * 0.92, 30, 170);
  }

  function addToken(data) {
    const m = activeMap(); if (!m) return null;
    const t = normalizeToken(Object.assign({
      id: uid(), name: 'Token', x: 50, y: 50, size: 1, color: '#a33', img: '',
      hp: 10, hpMax: 10, owner: '', charId: null, hidden: false, inInit: true, initMod: 0,
      type: 'npc', mapId: m.id
    }, data || {}));
    S.tokens.push(t);
    scheduleSave();
    renderTokens(); renderTokenAdmin();
    return t;
  }

  function renderTokens() {
    const layer = $('#tokenLayer'); if (!layer) return;
    layer.innerHTML = '';
    const frag = document.createDocumentFragment();
    tokensOnActiveMap().forEach(t => {
      if (me.role !== 'gm' && t.hidden) return;
      const el = document.createElement('div');
      el.className = 'token' + (t.hidden ? ' hidden-token' : '');
      el.dataset.id = t.id;
      el.title = t.name;
      const px = tokenPixelSize(t);
      el.style.width = px + 'px';
      el.style.height = px + 'px';
      el.style.left = t.x + '%';
      el.style.top = t.y + '%';
      el.style.backgroundColor = t.img ? 'rgba(18, 9, 13, .92)' : (t.color || '#666');
      if (t.img) el.style.backgroundImage = `url("${t.img}")`;
      const pct = t.hpMax > 0 ? clamp((t.hp / t.hpMax) * 100, 0, 100) : 0;
      el.innerHTML = `${t.img ? '' : `<span class="label">${esc((t.name || '?').slice(0, 2).toUpperCase())}</span>`}<span class="hpbar"><i style="width:${pct}%"></i></span>`;
      if ((S.initiative.order || [])[S.initiative.index] === t.id) el.classList.add('selected');
      el.addEventListener('pointerdown', onTokenPointerDown);
      el.addEventListener('click', e => {
        if (suppressTokenClick) { suppressTokenClick = false; return; }
        if (me.role === 'gm' && structureEditable()) { e.stopPropagation(); openTokenModal(t.id); }
      });
      frag.appendChild(el);
    });
    layer.appendChild(frag);
  }

  function onTokenPointerDown(e) {
    const id = e.currentTarget.dataset.id;
    const t = S.tokens.find(x => x.id === id);
    if (!t || !canControlToken(t)) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    drag = { id, startX: e.clientX, startY: e.clientY, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
  }

  function onBoardPointerMove(e) {
    if (painting && me.role === 'gm') { paintFogAt(e); return; }
    if (!drag) return;
    const t = S.tokens.find(x => x.id === drag.id); if (!t) return;
    const rect = boardRect();
    const dx = ((e.clientX - drag.startX) / rect.width) * 100;
    const dy = ((e.clientY - drag.startY) / rect.height) * 100;
    if (Math.abs(dx) + Math.abs(dy) > 0.2) drag.moved = true;
    t.x = clamp(t.x + dx, 0, 100);
    t.y = clamp(t.y + dy, 0, 100);
    drag.startX = e.clientX; drag.startY = e.clientY;
    const el = $(`.token[data-id="${t.id}"]`);
    if (el) { el.style.left = t.x + '%'; el.style.top = t.y + '%'; }
  }

  function onBoardPointerUp() {
    if (painting) {
      painting = false; lastPaint = null;
      saveFogImage(); scheduleSave();
      return;
    }
    if (!drag) return;
    const t = S.tokens.find(x => x.id === drag.id);
    suppressTokenClick = !!drag.moved;
    if (suppressTokenClick) setTimeout(() => { suppressTokenClick = false; }, 60);
    drag = null;
    if (t) {
      if (me.role === 'gm') scheduleSave();
      else sendToHost({ t: 'tokenMove', id: t.id, x: t.x, y: t.y, who: me.name });
    }
  }

  /* =====================================================================
     NÉVOA (máscara offscreen + cache)
     ===================================================================== */
  let fogMask = document.createElement('canvas');
  let fogMaskMap = null, fogMaskW = 0, fogMaskH = 0, fogMaskSrc = null;
  let fogCacheSrc = '', fogCacheImg = null;

  function loadFogImage(src, cb) {
    if (fogCacheSrc === src && fogCacheImg && fogCacheImg.complete && fogCacheImg.naturalWidth) { cb(fogCacheImg); return; }
    const img = new Image();
    img.onload = () => { fogCacheSrc = src; fogCacheImg = img; cb(img); };
    img.onerror = () => cb(null);
    img.src = src;
  }

  function ensureFogMask() {
    const b = $('#board'); if (!b) return false;
    const m = activeMap(); if (!m) return false;
    const w = Math.max(1, b.clientWidth), h = Math.max(1, b.clientHeight);
    const src = m.fogImage || (m.fogCovered ? 'covered' : '');
    if (fogMaskMap === m.id && fogMaskW === w && fogMaskH === h && fogMaskSrc === src) return true;
    fogMaskMap = m.id; fogMaskW = w; fogMaskH = h; fogMaskSrc = src;
    fogMask.width = w; fogMask.height = h;
    const ctx = fogMask.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (m.fogImage) {
      loadFogImage(m.fogImage, img => {
        if (!img || fogMaskSrc !== src) return;
        const c2 = fogMask.getContext('2d');
        c2.clearRect(0, 0, w, h);
        c2.drawImage(img, 0, 0, w, h);
        compositeFog();
      });
    } else if (m.fogCovered) {
      ctx.fillStyle = '#080305';
      ctx.fillRect(0, 0, w, h);
    }
    return true;
  }

  function compositeFog() {
    const vis = $('#fogCanvas'), b = $('#board');
    if (!vis || !b) return;
    const w = Math.max(1, b.clientWidth), h = Math.max(1, b.clientHeight);
    if (!ensureFogMask()) return;
    if (vis.width !== w || vis.height !== h) { vis.width = w; vis.height = h; }
    const ctx = vis.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = me.role === 'gm' ? 0.5 : 1;
    ctx.drawImage(fogMask, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  function drawFog() { ensureFogMask(); compositeFog(); }

  function paintFogAt(e) {
    if (!ensureFogMask()) return;
    const ctx = fogMask.getContext('2d');
    const rect = boardRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const size = parseInt($('#fogSize').value, 10) || 40;
    const mode = $('#fogMode').value;
    ctx.globalCompositeOperation = mode === 'reveal' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#080305';
    ctx.fillStyle = '#080305';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.beginPath();
    if (lastPaint) { ctx.moveTo(lastPaint.x, lastPaint.y); ctx.lineTo(x, y); ctx.stroke(); }
    else { ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
    lastPaint = { x, y };
    compositeFog();
  }

  function saveFogImage() {
    const m = activeMap(); if (!m || !fogMaskW) return;
    try {
      m.fogImage = fogMask.toDataURL('image/png');
      m.fogCovered = false;
      fogMaskSrc = m.fogImage;
    } catch { }
  }

  function onBoardPointerDown(e) {
    if (e.target.closest('.token') || e.target.closest('.board-toolbar') || e.target.closest('.dice-dock')) return;
    const fog = $('#fogPaint');
    if (me.role === 'gm' && S.mode === 'edit' && fog && fog.checked) {
      painting = true; lastPaint = null;
      paintFogAt(e);
      try { $('#board').setPointerCapture(e.pointerId); } catch { }
    }
  }

  function coverAllFog(reveal) {
    if (!requireEdit()) return;
    const m = activeMap(); if (!m) return;
    m.fogImage = null;
    m.fogCovered = !reveal;
    fogMaskMap = null; fogMaskSrc = null;
    drawFog();
    scheduleSave();
    log(reveal ? 'Névoa revelada.' : 'Névoa cobriu o mapa.');
  }
  /* =====================================================================
     DADOS / FALHA CRÍTICA
     ===================================================================== */
  function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }

  function playRollFx(die, results, who, totalText) {
    const list = Array.isArray(results) ? results : [Number(results) || 1];
    list.forEach((v, i) => setTimeout(() => spawnDieVisual(v, die, who, i === list.length - 1 ? totalText : ''), i * 110));
  }

  function spawnDieVisual(value, sides, who, totalText) {
    const stage = $('#diceStage'); if (!stage) return;
    while (stage.children.length > 16) stage.firstChild.remove();
    const d = document.createElement('div');
    d.className = 'die d' + sides
      + (sides === 20 && value === 20 ? ' crit' : '')
      + (sides === 20 && value === 1 ? ' fumble' : '');
    d.style.left = (30 + Math.random() * 40) + '%';
    d.style.top = (35 + Math.random() * 30) + '%';
    d.style.setProperty('--tx', (Math.random() * 40 - 20).toFixed(0) + 'px');
    d.innerHTML = `<span class="who">${esc(who || me.name || 'Jogador')}</span><span>${value}</span><span class="faces">d${sides}</span>${totalText ? `<span class="total">${esc(totalText)}</span>` : ''}`;
    stage.appendChild(d);
    setTimeout(() => d.remove(), 3600);
  }

  function showCriticalFailure(name, broadcast) {
    const ov = $('#fumbleOverlay'), nameEl = $('#fumbleName');
    if (!ov) return;
    if (nameEl) nameEl.textContent = name || 'Alguém';
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
    ov.classList.remove('play');
    void ov.offsetWidth;
    ov.classList.add('play');
    clearTimeout(fumbleTimer);
    fumbleTimer = setTimeout(() => {
      ov.classList.remove('play');
      setTimeout(() => {
        ov.classList.add('hidden');
        ov.setAttribute('aria-hidden', 'true');
      }, 500);
    }, 4300);
    if (broadcast) broadcastToPlayers({ t: 'fumble', name: name || 'Alguém' });
  }

  function doRoll(die, qty, mod, who, label, attrMod) {
    die = clamp(parseInt(die, 10) || 20, 2, 100);
    qty = clamp(parseInt(qty, 10) || 1, 1, 10);
    mod = parseInt(mod, 10) || 0;
    attrMod = parseInt(attrMod, 10) || 0;
    const whoName = String(who || '').trim() || me.name || 'Jogador';
    const totalMod = mod + attrMod;
    const results = Array.from({ length: qty }, () => rollDie(die));
    const sum = results.reduce((a, b) => a + b, 0);
    const total = sum + totalMod;
    const totalText = (qty > 1 || totalMod) ? `= ${total}` : '';

    playRollFx(die, results, whoName, totalText);

    const parts = [];
    if (attrMod) parts.push(`atrib ${attrMod >= 0 ? '+' : ''}${attrMod}`);
    if (mod) parts.push(`mod ${mod >= 0 ? '+' : ''}${mod}`);
    addLog(`${whoName} rolou ${qty > 1 ? qty + '×' : ''}d${die}${label ? ` (${label})` : ''}${parts.length ? ` [${parts.join(', ')}]` : ''}: [${results.join(', ')}]${(qty > 1 || totalMod) ? ` = ${total}` : ''}`, 'roll', false);

    // 1 natural em d20 SEMPRE causa falha crítica, independente de bônus.
    const nat1 = die === 20 && results.includes(1);
    if (nat1) {
      addLog(`${whoName} sofreu FALHA CRÍTICA (1 natural).`, 'fumble', false);
      setTimeout(() => showCriticalFailure(whoName, true), 650 + results.length * 110);
    }

    if (me.role === 'gm') {
      broadcastToPlayers({ t: 'rollFx', die, results, who: whoName, totalText });
      scheduleSave();
    }
    renderLog();
  }

  function requestRoll(die) {
    const qty = $('#diceQty').value;
    const extra = parseInt($('#diceMod').value, 10) || 0;
    const charId = $('#rollAs').value;
    const c = charById(charId);
    const attrKey = $('#rollAttr').value;
    let attrMod = 0, label = '', who = me.name || 'Jogador';

    if (c) {
      who = c.name;
      if (attrKey && c.attrs) {
        attrMod = c.attrs[attrKey] || 0;
        label = (ATTRS.find(a => a[0] === attrKey) || [])[1] || attrKey;
      }
    } else if (attrKey) {
      label = (ATTRS.find(a => a[0] === attrKey) || [])[1] || attrKey;
    }

    if (me.role === 'gm') doRoll(die, qty, extra, who, label, attrMod);
    else if (hostConn && hostConn.open) sendToHost({ t: 'roll', die, qty, mod: extra, attrMod, who, label });
    else toast('Conecte-se à sala do mestre para rolar os dados.');
  }

  function renderRollAs() {
    const sel = $('#rollAs'); if (!sel) return;
    const list = me.role === 'gm' ? S.characters : myCharacters();
    const prev = sel.value;
    sel.innerHTML = `<option value="">— Usar meu nick (${esc(me.name || 'Jogador')}) —</option>`
      + list.map(c => `<option value="${c.id}" ${c.id === prev ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const dock = $('#dockWho');
    if (dock) {
      const chosen = charById(sel.value);
      dock.textContent = `Rolar como ${chosen ? chosen.name : (me.name || 'você')}`;
    }
  }

  /* =====================================================================
     INICIATIVA
     ===================================================================== */
  function rollInitiative() {
    const entries = [];
    tokensOnActiveMap().forEach(t => {
      if (t.hidden || t.inInit === false) return;
      let mod = +t.initMod || 0;
      if (t.charId) {
        const c = charById(t.charId);
        if (c && c.attrs) mod += (c.attrs.des || 0);
      }
      const roll = rollDie(20);
      entries.push({ id: t.id, name: t.name, roll, mod, total: roll + mod });
    });
    entries.sort((a, b) => b.total - a.total);
    S.initiative = { order: entries.map(e => e.id), details: entries, index: entries.length ? 0 : -1, round: 1 };
    log(`Iniciativa rolada (${entries.length}).`);
    scheduleSave();
    renderInitiative(); renderTokens();
  }

  function nextTurn() {
    const o = S.initiative.order || [];
    if (!o.length) return;
    S.initiative.index++;
    if (S.initiative.index >= o.length) {
      S.initiative.index = 0;
      S.initiative.round = (S.initiative.round || 1) + 1;
      log(`Rodada ${S.initiative.round}.`);
    }
    const t = S.tokens.find(x => x.id === o[S.initiative.index]);
    if (t) log(`Turno: ${t.name}.`, 'turn');
    scheduleSave();
    renderInitiative(); renderTokens();
  }

  function clearInitiative() {
    S.initiative = { order: [], details: [], index: -1, round: 1 };
    log('Iniciativa limpa.');
    scheduleSave();
    renderInitiative(); renderTokens();
  }

  function renderInitiative() {
    const ol = $('#initList'), empty = $('#initEmpty');
    if (!ol || !empty) return;
    const det = S.initiative.details || [];
    if (!det.length) { ol.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    ol.innerHTML = det.map((e, i) => `<li class="${i === S.initiative.index ? 'active' : ''}">${esc(e.name)} <span class="val">${e.total}</span> <span class="muted">(${e.roll}${e.mod ? (e.mod > 0 ? `+${e.mod}` : e.mod) : ''})</span></li>`).join('');
  }

  /* =====================================================================
     ADMIN / LISTAS
     ===================================================================== */
  function renderTokenAdmin() {
    const ul = $('#tokenList'); if (!ul) return;
    const list = tokensOnActiveMap();
    if (!list.length) { ul.innerHTML = `<li class="muted">Nenhum token neste ambiente.</li>`; return; }
    ul.innerHTML = list.map(t => `
      <li>
        <div><strong>${esc(t.name)}</strong> <span class="muted">PV ${t.hp}/${t.hpMax}${t.hidden ? ' · oculto' : ''}</span></div>
        <div class="actions">
          <button type="button" class="btn small" data-edit-token="${t.id}">Editar</button>
          <button type="button" class="btn small ghost" data-del-token="${t.id}">✕</button>
        </div>
      </li>`).join('');
  }

  function renderLibrary() {
    const ul = $('#libraryList'); if (!ul) return;
    if (!S.library.length) { ul.innerHTML = `<li class="muted">Sem biblioteca.</li>`; return; }
    ul.innerHTML = S.library.map((n, i) => `
      <li>
        <div><strong>${esc(n.n || n.name || 'Criatura')}</strong> <span class="muted">${n.hp ? ('PV ' + n.hp) : ''}</span></div>
        <div class="actions"><button type="button" class="btn small" data-lib="${i}">Colocar</button></div>
      </li>`).join('');
  }

  function renderLinks() {
    const ul = $('#linkList'); if (!ul) return;
    if (!S.characters.length) { ul.innerHTML = `<li class="muted">Cadastre e salve personagens para vincular jogadores.</li>`; return; }
    ul.innerHTML = S.characters.map(c => `
      <li>
        <div><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.clazz || '—')}</span></div>
        <div class="muted">${c.owner ? `→ ${esc(c.owner)}` : '(sem vínculo)'}</div>
      </li>`).join('');
  }

  function openTokenModal(id) {
    if (!structureEditable()) { toast('Ative o Modo Editor para editar tokens.'); return; }
    const t = S.tokens.find(x => x.id === id); if (!t) return;
    const form = $('#tokenForm'); if (!form) return;
    form.dataset.id = id;
    form.innerHTML = `
      <label>Nome <input name="name" value="${esc(t.name)}"></label>
      <div class="grid2">
        <label>PV atual <input name="hp" type="number" value="${t.hp}"></label>
        <label>PV máx <input name="hpMax" type="number" value="${t.hpMax}"></label>
        <label>Tamanho <input name="size" type="number" min="1" max="6" value="${t.size || 1}"></label>
        <label>Mod. iniciativa <input name="initMod" type="number" value="${t.initMod || 0}"></label>
        <label>Cor <input name="color" type="color" value="${esc(t.color || '#a33')}"></label>
        <label>Dono (jogador) <input name="owner" value="${esc(t.owner || '')}"></label>
      </div>
      <div class="row wrap">
        <label class="toggle"><input type="checkbox" name="hidden" ${t.hidden ? 'checked' : ''}> Oculto</label>
        <label class="toggle"><input type="checkbox" name="inInit" ${t.inInit !== false ? 'checked' : ''}> Iniciativa</label>
      </div>
      <div class="row wrap">
        <button type="button" class="btn small" id="btnTokenImg">Imagem</button>
        <button type="submit" class="btn primary">Salvar</button>
        <button type="button" class="btn danger ghost" id="btnTokenDelete">Excluir</button>
      </div>`;
    $('#modal').classList.remove('hidden');
    $('#modal').setAttribute('aria-hidden', 'false');

    $('#btnTokenImg').onclick = () => pickImage(512, src => {
      t.img = src; scheduleSave(); renderTokens();
    });
    $('#btnTokenDelete').onclick = () => {
      S.tokens = S.tokens.filter(x => x.id !== id);
      closeModal(); scheduleSave(); renderAll();
    };
  }

  function closeModal() { $('#modal').classList.add('hidden'); $('#modal').setAttribute('aria-hidden', 'true'); }
  function openCharModal() {
    $('#charModal').classList.remove('hidden');
    $('#charModal').setAttribute('aria-hidden', 'false');
    renderCharacters(); renderCharForm();
  }
  function closeCharModal() { $('#charModal').classList.add('hidden'); $('#charModal').setAttribute('aria-hidden', 'true'); }
  function openGmModal() {
    if (!structureEditable()) { toast('Ative o Modo Editor para abrir o painel de edição.'); return; }
    $('#gmModal').classList.remove('hidden');
    $('#gmModal').setAttribute('aria-hidden', 'false');
    renderMapList(); renderTokenAdmin(); renderLibrary(); renderLinks();
  }
  function closeGmModal() { $('#gmModal').classList.add('hidden'); $('#gmModal').setAttribute('aria-hidden', 'true'); }

  function toast(msg) {
    const el = $('#toast'); if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  /* =====================================================================
     IMAGENS / GRIMOIRE
     ===================================================================== */
  function pickImage(max, cb) {
    const inp = $('#imagePicker'); if (!inp) return;
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          const s = Math.min(1, max / Math.max(w, h));
          w = Math.max(1, Math.round(w * s));
          h = Math.max(1, Math.round(h * s));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          let out = '';
          try {
            out = cv.toDataURL('image/webp', 0.82);
            if (!out.startsWith('data:image/webp')) out = '';
          } catch { }
          if (!out) out = cv.toDataURL('image/jpeg', 0.82);
          cb(out);
        };
        img.onerror = () => toast('Não foi possível ler a imagem.');
        img.src = r.result;
      };
      r.readAsDataURL(f);
      inp.value = '';
    };
    inp.click();
  }

  function mergeLibrary(npcs) {
    const seen = new Set(S.library.map(n => normName(n.n || n.name)));
    (npcs || []).forEach(n => {
      const key = normName(n.n || n.name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      S.library.push(n);
    });
  }

  async function loadBundledGrimoire() {
    try {
      const res = await fetch('grimoire-campanha.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const npcs = Array.isArray(data.npcs) ? data.npcs : (Array.isArray(data) ? data : []);
      if (npcs.length) { mergeLibrary(npcs); renderLibrary(); }
    } catch { }
  }

  function importGrimoireFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (Array.isArray(data.npcs)) mergeLibrary(data.npcs);
        else if (Array.isArray(data)) mergeLibrary(data);
        if (Array.isArray(data.characters)) {
          data.characters.forEach(c => {
            normalizeCharacter(c);
            const i = S.characters.findIndex(x => x.id === c.id);
            if (i >= 0) S.characters[i] = c; else S.characters.push(c);
          });
        }
        log('Grimoire importado.');
        scheduleSave(true);
        renderAll();
        toast('Grimoire importado.');
      } catch { alert('Arquivo inválido.'); }
    };
    r.readAsText(file);
  }
  /* =====================================================================
     RENDER GERAL / MODOS
     ===================================================================== */
  function updateModeUI() {
    const mode = S.mode === 'play' ? 'play' : 'edit';
    document.body.classList.toggle('is-gm', me.role === 'gm');
    document.body.classList.toggle('is-player', me.role !== 'gm');
    document.body.classList.toggle('mode-play', mode === 'play');
    document.body.classList.toggle('mode-edit', mode === 'edit');
    const badge = $('#modeBadge');
    if (badge) badge.textContent = mode === 'play' ? 'Modo Jogar' : 'Modo Editor';
    $$('#modeSwitch [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  }

  function setMode(mode) {
    if (me.role !== 'gm') return;
    const next = mode === 'play' ? 'play' : 'edit';
    if (S.mode === next) return;
    S.mode = next;
    if (next === 'play') {
      painting = false; lastPaint = null;
      const fog = $('#fogPaint');
      if (fog) fog.checked = false;
      closeGmModal();
    }
    log(next === 'play' ? 'Modo Jogar ativado.' : 'Modo Editor ativado.');
    renderAll();
    scheduleSave(true);
    toast(next === 'play'
      ? 'Modo Jogar: narração, dados e movimento liberados.'
      : 'Modo Editor: edição completa liberada.');
  }

  function renderAll() {
    updateModeUI();
    const roomTitle = $('#roomTitle');
    if (roomTitle) roomTitle.textContent = S.room ? `Sala ${S.room}` : 'Mesa local';
    const m = activeMap();
    const roomMeta = $('#roomMeta');
    if (roomMeta) roomMeta.textContent = `${me.role === 'gm' ? 'Mestre' : 'Jogador'}: ${me.name || '—'}${m ? ` · ${m.name}` : ''}`;

    renderMapSelect();
    renderMapList();
    if (m) {
      const gc = $('#gridCols'), gr = $('#gridRows');
      if (gc) gc.value = m.cols;
      if (gr) gr.value = m.rows;
    }
    renderMap();
    renderTokens();
    renderInitiative();
    renderLog();
    renderCharacters();
    renderCharForm();
    renderTokenAdmin();
    renderLibrary();
    renderLinks();
    renderRollAs();
    requestLayout();
  }

  /* =====================================================================
     NAVEGAÇÃO / SALA
     ===================================================================== */
  function showLanding() {
    $('#landing')?.classList.remove('hidden');
    $('#lobby')?.classList.add('hidden');
    $('#app')?.classList.add('hidden');
    document.body.classList.remove('in-app', 'panel-open');
    closeCharModal(); closeGmModal(); closeModal();
    window.scrollTo(0, 0);
  }

  function showLobby() {
    $('#landing')?.classList.add('hidden');
    $('#lobby')?.classList.remove('hidden');
    $('#app')?.classList.add('hidden');
    document.body.classList.remove('in-app', 'panel-open');
    window.scrollTo(0, 0);
    setTimeout(() => { const n = $('#playerName'); if (n) n.focus(); }, 60);
  }

  function showApp() {
    $('#landing')?.classList.add('hidden');
    $('#lobby')?.classList.add('hidden');
    $('#app')?.classList.remove('hidden');
    $('#app')?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('in-app');
    renderAll();
    requestAnimationFrame(() => requestLayout());
  }

  function setConn(text, ok) {
    const b = $('#connBadge'); if (!b) return;
    b.textContent = text;
    b.classList.toggle('ok', !!ok);
  }

  function startHost(room) {
    me.role = 'gm';
    if (room) {
      try {
        const raw = localStorage.getItem('kakarpg_' + room);
        if (raw) S = JSON.parse(raw);
      } catch { }
    }
    S.room = room || '';
    normalizeState();
    showApp();
    saveLocal();
    loadBundledGrimoire();
    if (!room) { setConn('local', true); return; }
    setConn('abrindo...', false);
    peer = new Peer('kaka-' + room, { debug: 0 });
    peer.on('open', () => setConn('online', true));
    peer.on('connection', c => {
      conns.push(c);
      c.on('open', () => { try { c.send(JSON.stringify({ t: 'state', s: playerView() })); } catch { } });
      c.on('data', msg => handleMsg(msg, c));
      c.on('close', () => { conns = conns.filter(x => x !== c); addLog(`${c.nick || 'Um jogador'} saiu.`, 'info', false); broadcastState(); });
      c.on('error', () => { });
    });
    peer.on('error', err => {
      setConn('erro', false);
      if (err.type === 'unavailable-id') toast('Este código de sala já está em uso. Escolha outro.');
      else alert('Erro de conexão: ' + err.type);
    });
  }

  function startJoin(room) {
    me.role = 'player';
    S = defaultState();
    S.room = room;
    normalizeState();
    showApp();
    setConn('conectando...', false);
    clearTimeout(joinTimer);
    joinTimer = setTimeout(() => {
      if (hostConn && hostConn.open) return;
      setConn('sem conexão', false);
      toast('Não foi possível falar com a sala. Confira o código e se o mestre está online.');
      const lm = $('#lobbyMsg');
      if (lm) lm.textContent = 'Conexão não estabelecida. Confira o código da sala e tente novamente.';
    }, 12000);
    peer = new Peer();
    peer.on('open', () => {
      hostConn = peer.connect('kaka-' + room, { reliable: true });
      hostConn.on('open', () => {
        clearTimeout(joinTimer);
        setConn('online', true);
        try { hostConn.send(JSON.stringify({ t: 'hello', name: me.name })); } catch { }
      });
      hostConn.on('data', msg => handleMsg(msg, hostConn));
      hostConn.on('close', () => { setConn('desconectado', false); addLog('Conexão perdida.', 'info', false); renderLog(); });
      hostConn.on('error', () => { clearTimeout(joinTimer); setConn('erro', false); });
    });
    peer.on('error', err => {
      clearTimeout(joinTimer);
      setConn('erro', false);
      alert('Não foi possível conectar: ' + err.type);
    });
  }

  function initReveals() {
    const els = $$('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach(e => e.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(e => io.observe(e));
    // Fallback: em abas em segundo plano o observer pode não disparar.
    setTimeout(() => {
      if (!document.querySelector('.reveal.in')) els.forEach(e => e.classList.add('in'));
    }, 2500);
  }

  /* =====================================================================
     BIND
     ===================================================================== */
  function bind() {
    $$('[data-goto-lobby]').forEach(b => b.addEventListener('click', showLobby));
    $$('[data-goto-landing]').forEach(b => b.addEventListener('click', showLanding));

    $('#btnHost').onclick = () => {
      me.name = $('#playerName').value.trim() || 'Mestre';
      const room = $('#roomCode').value.trim().toUpperCase();
      rememberSession(me.name, room);
      startHost(room);
    };
    $('#btnJoin').onclick = () => {
      me.name = $('#playerName').value.trim() || 'Jogador';
      const room = $('#roomCode').value.trim().toUpperCase();
      if (!room) { $('#lobbyMsg').textContent = 'Informe o código da sala.'; return; }
      rememberSession(me.name, room);
      startJoin(room);
    };
    $('#btnSolo').onclick = () => {
      me.name = $('#playerName').value.trim() || 'Mestre';
      startHost('');
    };
    $('#roomCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnJoin').click(); });
    $('#btnLeave').onclick = () => { if (confirm('Sair da mesa? A campanha fica salva neste navegador.')) location.reload(); };

    $('#btnOpenChars').onclick = openCharModal;
    $('#btnOpenGm').onclick = openGmModal;
    $('#btnTogglePanel').onclick = () => document.body.classList.toggle('panel-open');
    $('#btnClosePanel').onclick = () => document.body.classList.remove('panel-open');
    $('#panelScrim').onclick = () => document.body.classList.remove('panel-open');

    $('#charModal').addEventListener('click', e => { if (e.target.dataset.closeChar) closeCharModal(); });
    $('#gmModal').addEventListener('click', e => { if (e.target.dataset.closeGm) closeGmModal(); });
    $('#modal').addEventListener('click', e => { if (e.target.dataset.close) closeModal(); });

    $$('#modeSwitch [data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    $('#mapSelect').onchange = e => setActiveMap(e.target.value);

    $$('.die-btn, .die-chip').forEach(b => b.addEventListener('click', () => requestRoll(parseInt(b.dataset.die, 10))));

    $('#btnClearLog').onclick = () => { S.log = []; renderLog(); if (me.role === 'gm') scheduleSave(); };
    $('#btnRollInit').onclick = rollInitiative;
    $('#btnNextTurn').onclick = nextTurn;
    $('#btnClearInit').onclick = clearInitiative;

    const board = $('#board');
    board.addEventListener('pointerdown', onBoardPointerDown);
    window.addEventListener('pointermove', onBoardPointerMove, { passive: true });
    window.addEventListener('pointerup', onBoardPointerUp);
    window.addEventListener('pointercancel', onBoardPointerUp);

    $('#toggleGrid').onchange = drawGrid;
    $('#btnFit').onclick = () => { requestLayout(); toast('Vista centralizada.'); };
    window.addEventListener('resize', requestLayout);
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => requestLayout()).observe(board);
    }

    $('#fogPaint').onchange = e => {
      if (e.target.checked && !structureEditable()) {
        e.target.checked = false;
        toast('Ative o Modo Editor para pintar a névoa.');
      }
    };

    /* ---------- ficha ---------- */
    $('#btnNewChar').onclick = () => {
      if (!requireEdit()) return;
      const c = blankCharacter();
      S.characters.push(c);
      selectedCharId = c.id;
      upsertCharacter(c, true);
      openCharModal();
      setTimeout(() => {
        const n = $('#charForm input[name="name"]');
        if (n) { n.focus(); n.select(); }
      }, 60);
    };

    $('#charList').onclick = e => {
      const li = e.target.closest('li[data-id]'); if (!li) return;
      selectedCharId = li.dataset.id;
      renderCharacters(); renderCharForm();
    };

    $('#charForm').addEventListener('submit', e => {
      e.preventDefault();
      const c = readCharFormBase(); if (!c) return;
      if (me.role === 'gm') {
        upsertCharacter(c, true);
        toast('Personagem salvo.');
      } else {
        sendToHost({
          t: 'charPatch', id: c.id, who: me.name,
          patch: {
            inventoryItems: c.inventoryItems, notes: c.notes, powers: c.powers,
            stats: { hp: c.hp, mp: c.mp, san: c.san, def: c.def }
          }
        });
        addLog('Alterações enviadas ao mestre.', 'info', false);
        renderLog();
        toast('Alterações enviadas ao mestre.');
      }
    });

    const clazzInput = $('#charForm input[name="clazz"]');
    clazzInput.addEventListener('input', () => {
      if (!structureEditable()) return;
      const c = charById(selectedCharId); if (!c) return;
      const maxP = maxPowerSlots({ clazz: clazzInput.value });
      const sel = $('#charForm [name="powerSlots"]');
      const cur = parseInt(sel.value, 10) || 0;
      fillPowerOptions(sel, Math.min(cur, maxP), maxP);
      const label = $('#powerMaxLabel');
      if (label) label.textContent = maxP === 4 ? 'máx. 4 (mago)' : 'máx. 3';
      const preview = Object.assign({}, c, { clazz: clazzInput.value, powerSlots: parseInt(sel.value, 10) || 0 });
      renderPowers(preview);
    });

    $('#charForm [name="powerSlots"]').addEventListener('change', e => {
      const c = charById(selectedCharId); if (!c) return;
      const clazz = $('#charForm input[name="clazz"]');
      const maxP = maxPowerSlots({ clazz: clazz ? clazz.value : c.clazz });
      c.powerSlots = clamp(parseInt(e.target.value, 10) || 0, 0, maxP);
      e.target.value = String(c.powerSlots);
      renderPowers(c);
    });

    $('#statusBars').addEventListener('click', e => {
      const btn = e.target.closest('[data-delta]'); if (!btn) return;
      const bar = e.target.closest('.stat-bar'); if (!bar) return;
      const c = charById(selectedCharId); if (!c) return;
      if (me.role !== 'gm' && !canControlCharacter(c, me.name)) return;
      const k = bar.dataset.key;
      c[k] = clamp((c[k] || 0) + (parseInt(btn.dataset.delta, 10) || 0), 0, c[k + 'Max'] || 0);
      syncCharToTokens(c);
      if (me.role === 'gm') { scheduleSave(); renderCharForm(); renderTokens(); }
      else {
        sendToHost({ t: 'charPatch', id: c.id, who: me.name, patch: { stats: { [k]: c[k] } } });
        renderCharForm(); renderTokens();
      }
    });

    $('#statusBars').addEventListener('input', e => {
      const inp = e.target.closest('[data-max-key]');
      if (!inp || !structureEditable()) return;
      const c = charById(selectedCharId); if (!c) return;
      const k = inp.dataset.maxKey;
      c[k + 'Max'] = Math.max(0, parseInt(inp.value, 10) || 0);
      c[k] = clamp(c[k], 0, c[k + 'Max']);
      const bar = inp.closest('.stat-bar');
      if (bar) {
        const nums = bar.querySelector('.nums');
        if (nums) nums.innerHTML = `<b data-val>${c[k]}</b> / ${c[k + 'Max']}`;
        const fill = bar.querySelector('.fill');
        if (fill) fill.style.width = (c[k + 'Max'] > 0 ? clamp((c[k] / c[k + 'Max']) * 100, 0, 100) : 0) + '%';
      }
      syncCharToTokens(c);
      scheduleSave();
    });

    $('#attrGrid').addEventListener('click', e => {
      const rb = e.target.closest('[data-roll-attr]'); if (!rb) return;
      const c = charById(selectedCharId); if (!c) return;
      const k = rb.dataset.rollAttr;
      const attrMod = c.attrs[k] || 0;
      const label = (ATTRS.find(a => a[0] === k) || [])[1] || k;
      if (me.role === 'gm') doRoll(20, 1, 0, c.name, label, attrMod);
      else sendToHost({ t: 'roll', die: 20, qty: 1, mod: 0, attrMod, who: c.name, label });
    });

    $('#btnCharImage').onclick = () => {
      if (!requireEdit()) return;
      const c = charById(selectedCharId); if (!c) return;
      pickImage(512, src => {
        c.img = src;
        syncCharToTokens(c);
        renderCharForm(); renderTokens(); scheduleSave();
      });
    };

    $('#btnDeleteChar').onclick = () => {
      if (!requireEdit()) return;
      if (selectedCharId && confirm('Excluir personagem e tokens vinculados?')) deleteCharacter(selectedCharId);
    };

    $('#btnCharToToken').onclick = () => {
      if (!requireEdit()) return;
      const c = readCharFormBase() || charById(selectedCharId); if (!c) return;
      upsertCharacter(c, true);
      const m = activeMap();
      const offset = (S.tokens.filter(t => t.mapId === m.id).length % 6) * 6;
      addToken({
        name: c.name, img: c.img, hp: c.hp, hpMax: c.hpMax, owner: c.owner,
        charId: c.id, color: '#c44', type: 'pc', x: 22 + offset, y: 30 + offset
      });
      log(`Token criado: ${c.name}.`);
      toast('Token criado no ambiente ativo.');
    };

    $('#btnAddItem').onclick = () => {
      const c = charById(selectedCharId); if (!c) return;
      if (me.role !== 'gm' && !canControlCharacter(c, me.name)) return;
      if (c.inventoryItems.length >= c.inventoryLimit) { toast('Limite de inventário atingido.'); return; }
      c.inventoryItems.push('');
      renderInventory(c);
      const addBtn = $('#btnAddItem');
      if (addBtn) addBtn.disabled = c.inventoryItems.length >= c.inventoryLimit;
    };

    $('#inventoryList').addEventListener('click', e => {
      const b = e.target.closest('[data-del-inv]'); if (!b) return;
      const c = charById(selectedCharId); if (!c) return;
      if (me.role !== 'gm' && !canControlCharacter(c, me.name)) return;
      c.inventoryItems.splice(+b.dataset.delInv, 1);
      renderInventory(c);
      const addBtn = $('#btnAddItem');
      if (addBtn) addBtn.disabled = c.inventoryItems.length >= c.inventoryLimit;
    });

    /* ---------- grimoire ---------- */
    $('#btnImportGrimoire').onclick = () => { if (requireEdit()) $('#grimoireFile').click(); };
    $('#grimoireFile').onchange = e => {
      const f = e.target.files[0];
      if (f) importGrimoireFile(f);
      e.target.value = '';
    };

    /* ---------- mapas ---------- */
    $('#btnNewMap').onclick = createMap;
    $('#mapNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') createMap(); });
    $('#mapList').addEventListener('click', e => {
      const act = e.target.closest('[data-activate-map]');
      if (act) { setActiveMap(act.dataset.activateMap); return; }
      const ren = e.target.closest('[data-rename-map]');
      if (ren) { renameMap(ren.dataset.renameMap); return; }
      const del = e.target.closest('[data-del-map]');
      if (del) deleteMap(del.dataset.delMap);
    });
    $('#btnApplyGrid').onclick = applyGrid;
    $('#btnMapUpload').onclick = () => {
      if (!requireEdit()) return;
      const m = activeMap(); if (!m) return;
      pickImage(1600, src => {
        m.src = src;
        log(`Imagem do ambiente ${m.name} atualizada.`);
        scheduleSave(true);
        renderMap(); renderMapList(); renderMapSelect();
        toast('Mapa atualizado.');
      });
    };
    $('#btnMapClear').onclick = () => {
      if (!requireEdit()) return;
      const m = activeMap(); if (!m) return;
      m.src = ''; m.fogImage = null; m.fogCovered = false;
      fogMaskMap = null; fogMaskSrc = null;
      log(`Imagem removida de ${m.name}.`);
      scheduleSave(true);
      renderAll();
    };
    $('#btnFogCover').onclick = () => coverAllFog(false);
    $('#btnFogReveal').onclick = () => coverAllFog(true);

    /* ---------- tokens / biblioteca ---------- */
    $('#btnAddEnemy').onclick = () => {
      if (!requireEdit()) return;
      addToken({ name: 'Inimigo', color: '#ff4d5a', type: 'enemy' });
      log('Inimigo adicionado.');
    };
    $('#btnAddNpc').onclick = () => {
      if (!requireEdit()) return;
      addToken({ name: 'NPC', color: '#ff8a5c', type: 'npc', inInit: false });
      log('NPC adicionado.');
    };
    $('#btnAddPlayers').onclick = () => {
      if (!requireEdit()) return;
      const m = activeMap(); if (!m) return;
      let added = 0;
      S.characters.forEach((c, i) => {
        if (S.tokens.some(t => t.mapId === m.id && t.charId === c.id)) return;
        addToken({
          name: c.name, img: c.img, hp: c.hp, hpMax: c.hpMax, owner: c.owner,
          charId: c.id, color: '#c44', type: 'pc',
          x: 14 + (i % 7) * 11, y: 78
        });
        added++;
      });
      log(added ? `Tokens de jogadores criados (${added}).` : 'Todos os jogadores já têm token neste ambiente.');
      renderTokens();
    };
    $('#tokenList').addEventListener('click', e => {
      const ed = e.target.closest('[data-edit-token]');
      const del = e.target.closest('[data-del-token]');
      if (ed) openTokenModal(ed.dataset.editToken);
      if (del) {
        if (!requireEdit()) return;
        S.tokens = S.tokens.filter(t => t.id !== del.dataset.delToken);
        scheduleSave(); renderAll();
      }
    });
    $('#libraryList').addEventListener('click', e => {
      const b = e.target.closest('[data-lib]'); if (!b) return;
      if (!requireEdit()) return;
      const n = S.library[+b.dataset.lib]; if (!n) return;
      addToken({
        name: n.n || n.name || 'Criatura', hp: n.hp || 10, hpMax: n.hp || 10,
        hidden: true, inInit: !!n.hp, type: 'npc', color: '#ff8a5c'
      });
      log(`Criatura adicionada: ${n.n || n.name}.`);
    });

    $('#tokenForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!requireEdit()) return;
      const id = e.target.dataset.id;
      const t = S.tokens.find(x => x.id === id); if (!t) return;
      const f = e.target;
      t.name = f.name.value;
      t.hp = Math.max(0, +f.hp.value || 0);
      t.hpMax = Math.max(1, +f.hpMax.value || 1);
      t.hp = clamp(t.hp, 0, t.hpMax);
      t.size = clamp(+f.size.value || 1, 1, 6);
      t.initMod = +f.initMod.value || 0;
      t.color = f.color.value;
      t.owner = f.owner.value.trim();
      t.hidden = f.hidden.checked;
      t.inInit = f.inInit.checked;
      if (t.charId) {
        const c = charById(t.charId);
        if (c) { c.hp = t.hp; c.hpMax = t.hpMax; c.name = t.name; syncCharToTokens(c); }
      }
      closeModal();
      scheduleSave();
      renderAll();
    });

    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (!$('#modal').classList.contains('hidden')) closeModal();
        else if (!$('#charModal').classList.contains('hidden')) closeCharModal();
        else if (!$('#gmModal').classList.contains('hidden')) closeGmModal();
        else document.body.classList.remove('panel-open');
      }
    });
  }

  function rememberSession(name, room) {
    try {
      localStorage.setItem('kakarpg_name', name);
      if (room) localStorage.setItem('kakarpg_room', room);
    } catch { }
  }

  function restoreSession() {
    try {
      const name = localStorage.getItem('kakarpg_name');
      const room = localStorage.getItem('kakarpg_room');
      if (name) { const n = $('#playerName'); if (n) n.value = name; }
      if (room) { const r = $('#roomCode'); if (r) r.value = room; }
    } catch { }
  }

  function init() {
    normalizeState();
    bind();
    restoreSession();
    updateModeUI();
    renderAll();
    initReveals();
    loadBundledGrimoire();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();



