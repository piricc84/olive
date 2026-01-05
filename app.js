import { DB, uid, todayISO, clamp } from "./db.js";

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const state = {
  route: "dashboard",
  q: "",
  position: null,
  traps: [],
  inspections: [],
  alerts: [],
  messages: [],
  media: [],
  outbox: [],
  settings: {
    unit: "trappole",
    nearRadiusM: 300,
    defaultThreshold: 5,
    enableWeather: true,
    enableNearbyAlert: true,
    whatsappNumber: "",
    contacts: [],
    enableWhatsappAlerts: true,
    enableWhatsappNearby: false
  },
  map: { obj: null, layer: null, markers: [] },
  charts: { weekly: null, byTrap: null, risk: null }
};

const DEFAULT_SITE = {
  name: "Bari Loseto",
  lat: 41.031518,
  lng: 16.852941
};

function toast(title, msg=""){
  const root = $("#toast");
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
  root.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transform="translateY(6px)"; }, 2800);
  setTimeout(()=> el.remove(), 3400);
}

function escapeHtml(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function cleanPhoneNumber(n){
  return String(n || "").replace(/[^\d]/g, "");
}

function getWhatsAppUrl(text, phoneOverride=null){
  const phone = cleanPhoneNumber(phoneOverride ?? state.settings.whatsappNumber);
  const encoded = encodeURIComponent(text);
  return phone ? `https://wa.me/${phone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}

function openWhatsApp(text, phoneOverride=null){
  window.open(getWhatsAppUrl(text, phoneOverride), "_blank");
}

function getWhatsappTargets(){
  const targets = [];
  const seen = new Set();
  const def = cleanPhoneNumber(state.settings.whatsappNumber);
  if(def){
    targets.push({ label: "Numero predefinito", phone: def });
    seen.add(def);
  }
  for(const c of (state.settings.contacts || [])){
    const phone = cleanPhoneNumber(c.phone);
    if(!phone || seen.has(phone)) continue;
    const label = c.role ? `${c.name} • ${c.role}` : c.name;
    targets.push({ label, phone });
    seen.add(phone);
  }
  return targets;
}

async function enqueueWhatsappNotification({ title, body, context=null }){
  const item = {
    id: uid("wa"),
    channel: "whatsapp",
    status: "pending",
    createdAt: new Date().toISOString(),
    title,
    body,
    context
  };
  await DB.put("outbox", item);
  state.outbox = await DB.getAll("outbox");
  return item;
}

async function openWhatsappSendModal(item){
  const targets = getWhatsappTargets();
  const text = `${item.title}\n${item.body}`;
  const options = targets.length
    ? targets.map((t, idx)=>`<option value="${t.phone}" ${idx===0 ? "selected":""}>${escapeHtml(t.label)} (${escapeHtml(t.phone)})</option>`).join("")
    : `<option value="">Nessun contatto salvato</option>`;
  const body = `
    <div class="row">
      <div class="field">
        <label>Destinatario</label>
        <select id="waTarget" ${targets.length ? "" : "disabled"}>${options}</select>
      </div>
      <div class="field">
        <label>Numero manuale (opzionale)</label>
        <input id="waCustom" placeholder="Es. 393331112233" />
      </div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>Testo messaggio (modificabile)</label>
      <textarea id="waText">${escapeHtml(text)}</textarea>
    </div>
    <div class="mini" style="margin-top:10px">
      L'invio avviene aprendo WhatsApp con testo precompilato.
    </div>
  `;
  openModal({
    title: "Invio WhatsApp",
    bodyHTML: body,
    footerButtons: [
      { id:"waCancel", label:"Annulla" },
      { id:"waSend", label:"Apri WhatsApp", kind:"primary" }
    ]
  });
  $("#waCancel").onclick = closeModal;
  $("#waSend").onclick = async ()=>{
    const custom = cleanPhoneNumber($("#waCustom").value.trim());
    const selected = $("#waTarget")?.value || "";
    const phone = custom || selected || "";
    const msg = $("#waText").value.trim();
    if(!msg){ toast("Testo mancante", "Inserisci un messaggio."); return; }
    openWhatsApp(msg, phone);
    const next = { ...item, status:"sent", sentAt: new Date().toISOString(), targetPhone: phone, body: msg };
    await DB.put("outbox", next);
    await loadAll();
    closeModal();
    render();
  };
}

function formatDate(iso){
  if(!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("it-IT", { year:"numeric", month:"short", day:"2-digit" });
}

function haversineMeters(a, b){
  if(!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (x)=> x*Math.PI/180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}

async function loadAll(){
  // settings (merge defaults)
  const saved = await DB.getSetting("app_settings", null);
  if(saved) state.settings = { ...state.settings, ...saved };

  state.traps = await DB.getAll("traps");
  state.inspections = await DB.getAll("inspections");
  state.alerts = await DB.getAll("alerts");
  state.messages = await DB.getAll("messages");
  state.media = await DB.getAll("media");
  state.outbox = await DB.getAll("outbox");

  // seed if empty
  if(state.traps.length === 0){
    await seedLoseto();
    state.traps = await DB.getAll("traps");
    state.inspections = await DB.getAll("inspections");
    state.alerts = await DB.getAll("alerts");
    state.messages = await DB.getAll("messages");
    state.media = await DB.getAll("media");
    state.outbox = await DB.getAll("outbox");
  }

  await migrateLegacyPhotos();
  updateBadges();
}

async function seedLoseto(){
  const center = { ...DEFAULT_SITE };
  const traps = [
    { id: uid("trap"), name:"Loseto Nord", code:"LO-001", lat:center.lat+0.0007, lng:center.lng+0.0005, type:"Cromotropica", bait:"Attrattivo ammoniacale", installDate: todayISO(), status:"Attiva", tags:["loseto","coratina"], notes:"Filare esposto al vento, sostituire pannello ogni 14 gg" },
    { id: uid("trap"), name:"Loseto Sud", code:"LO-002", lat:center.lat-0.0008, lng:center.lng-0.0006, type:"Feromonica", bait:"Feromone + ammonio", installDate: todayISO(), status:"Attiva", tags:["loseto","leccino"], notes:"Controllare dopo piogge intense" },
    { id: uid("trap"), name:"Loseto Est", code:"LO-003", lat:center.lat+0.0004, lng:center.lng+0.0011, type:"Cromotropica", bait:"Attrattivo proteico", installDate: todayISO(), status:"Attiva", tags:["loseto","frantoio"], notes:"Area irrigata, buona accessibilita" },
    { id: uid("trap"), name:"Loseto Ovest", code:"LO-004", lat:center.lat-0.0002, lng:center.lng-0.0011, type:"Feromonica", bait:"Feromone + ammonio", installDate: todayISO(), status:"In manutenzione", tags:["loseto","collina"], notes:"Sostituire capsula feromonica" },
    { id: uid("trap"), name:"Loseto Centro", code:"LO-005", lat:center.lat, lng:center.lng, type:"Cromotropica", bait:"Attrattivo ammoniacale", installDate: todayISO(), status:"Attiva", tags:["loseto","campione"], notes:"Punto di riferimento area monitoraggio" }
  ];
  for(const t of traps) await DB.put("traps", t);

  const byCode = Object.fromEntries(traps.map(t=>[t.code, t.id]));
  const inspections = [
    { code:"LO-001", daysAgo:1, adults:4, females:2, larvae:0, temperature:25.1, humidity:58, wind:6, notes:"Nella norma" },
    { code:"LO-002", daysAgo:1, adults:6, females:3, larvae:1, temperature:25.0, humidity:60, wind:5, notes:"Picco: valutare intervento" },
    { code:"LO-003", daysAgo:2, adults:3, females:1, larvae:0, temperature:24.2, humidity:62, wind:4, notes:"Trend in crescita" },
    { code:"LO-004", daysAgo:2, adults:2, females:1, larvae:0, temperature:23.6, humidity:59, wind:7, notes:"Nella norma" },
    { code:"LO-005", daysAgo:3, adults:5, females:2, larvae:0, temperature:24.8, humidity:57, wind:3, notes:"Sotto controllo" },
    { code:"LO-001", daysAgo:4, adults:2, females:1, larvae:0, temperature:23.9, humidity:55, wind:5, notes:"Nella norma" },
    { code:"LO-002", daysAgo:5, adults:4, females:2, larvae:0, temperature:23.4, humidity:61, wind:4, notes:"Trend in crescita" },
    { code:"LO-003", daysAgo:6, adults:1, females:0, larvae:0, temperature:22.8, humidity:63, wind:6, notes:"Nella norma" },
    { code:"LO-004", daysAgo:7, adults:0, females:0, larvae:0, temperature:22.1, humidity:60, wind:8, notes:"In manutenzione" },
    { code:"LO-005", daysAgo:8, adults:3, females:1, larvae:0, temperature:22.6, humidity:58, wind:5, notes:"Nella norma" },
    { code:"LO-001", daysAgo:10, adults:5, females:2, larvae:1, temperature:21.9, humidity:64, wind:4, notes:"Presenza larve" },
    { code:"LO-003", daysAgo:12, adults:2, females:1, larvae:0, temperature:21.2, humidity:66, wind:3, notes:"Nella norma" }
  ];
  for(const i of inspections){
    await DB.put("inspections", {
      id: uid("insp"),
      trapId: byCode[i.code],
      date: daysAgoISO(i.daysAgo),
      adults: i.adults,
      females: i.females,
      larvae: i.larvae,
      temperature: i.temperature,
      humidity: i.humidity,
      wind: i.wind,
      notes: i.notes,
      operator: "Team Loseto",
      source: "manual",
      sourceRef: "",
      sourceNote: "",
      mediaIds: []
    });
  }

  const alert1 = { id: uid("al"), name:"Soglia catture (adulti)", metric:"adults", threshold: 5, active: true, scope:"any", note:"Notifica quando una singola ispezione supera 5 adulti" };
  const alert2 = { id: uid("al"), name:"Presenza larve", metric:"larvae", threshold: 1, active: true, scope:"any", note:"Notifica alla prima larva rilevata" };
  const alert3 = { id: uid("al"), name:"Trappole vicine (300m)", metric:"nearby", threshold: state.settings.nearRadiusM, active: true, scope:"any", note:"Avvisa se sei vicino a una trappola quando apri la PWA" };
  for(const a of [alert1, alert2, alert3]) await DB.put("alerts", a);

  await DB.put("messages", {
    id: uid("msg"),
    date: new Date().toISOString(),
    channel: "Team",
    title: "Kickoff monitoraggio Loseto",
    body: "Dati pre-caricati per Bari Loseto. Usa la mappa per verificare le trappole e avvia le ispezioni.",
    tags: ["operativo", "loseto"]
  });
}

async function migrateLegacyPhotos(){
  const legacy = state.inspections.filter(i=>i.photoDataUrl && !i.mediaIds);
  if(!legacy.length) return;
  for(const insp of legacy){
    const mediaId = uid("media");
    await DB.put("media", {
      id: mediaId,
      inspectionId: insp.id,
      trapId: insp.trapId,
      kind: "image",
      dataUrl: insp.photoDataUrl,
      createdAt: insp.date || new Date().toISOString(),
      note: "legacy-photo"
    });
    insp.mediaIds = [mediaId];
    delete insp.photoDataUrl;
    await DB.put("inspections", insp);
  }
  state.media = await DB.getAll("media");
  state.inspections = await DB.getAll("inspections");
}

function updateBadges(){
  const activeAlerts = state.alerts.filter(a=>a.active).length;
  $("#badgeAlerts").textContent = String(activeAlerts);

  const nearby = computeNearbyTraps().length;
  $("#badgeNearby").textContent = String(nearby);
}

function setActiveNav(route){
  $$("#nav a").forEach(a=>{
    const r = a.getAttribute("data-route");
    a.classList.toggle("active", r === route);
  });
}

function routeFromHash(){
  const h = location.hash || "#/dashboard";
  const p = h.replace("#/","").split("?")[0];
  return p || "dashboard";
}

function applySearchFilter(items, fields){
  const q = state.q.trim().toLowerCase();
  if(!q) return items;
  return items.filter(it => fields.some(f => String(it[f]||"").toLowerCase().includes(q)));
}

function computeNearbyTraps(){
  if(!state.position) return [];
  const radius = Number(state.settings.nearRadiusM || 200);
  return state.traps
    .map(t => ({...t, dist: haversineMeters(state.position, {lat:t.lat, lng:t.lng})}))
    .filter(t => Number.isFinite(t.dist) && t.dist <= radius)
    .sort((a,b)=>a.dist-b.dist);
}

async function requestLocation({silent=false}={}){
  if(!("geolocation" in navigator)){
    if(!silent) toast("Geolocalizzazione non supportata", "Il browser non espone navigator.geolocation.");
    return null;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        state.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        updateBadges();
        if(!silent) toast("Posizione aggiornata", `Accuratezza ~${Math.round(pos.coords.accuracy)}m`);
        resolve(state.position);
      },
      (err)=>{
        if(!silent) toast("Posizione non disponibile", err.message || "Permessi negati o timeout.");
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 2000 }
    );
  });
}

async function requestNotifications(){
  if(!("Notification" in window)){
    toast("Notifiche non supportate", "Il browser non supporta Notification API.");
    return false;
  }
  if(Notification.permission === "granted"){
    toast("Notifiche attive", "Permesso già concesso.");
    return true;
  }
  const p = await Notification.requestPermission();
  if(p === "granted"){
    toast("Notifiche attive", "Permesso concesso.");
    return true;
  }
  toast("Notifiche disattivate", "Permesso non concesso.");
  return false;
}

function pushNotification(title, body){
  if(!("Notification" in window) || Notification.permission !== "granted") return;
  try{
    new Notification(title, { body, icon:"icons/icon-192.png" });
  }catch(e){
    // Some browsers require service worker for notifications; fallback to toast
    toast(title, body);
  }
}

function riskLabel(score){
  if(score >= 75) return { label:"Alto", cls:"danger" };
  if(score >= 45) return { label:"Medio", cls:"warn" };
  return { label:"Basso", cls:"ok" };
}

function sourceLabel(code){
  const map = { manual:"Manuale", image:"Foto", sensor:"Sensore", import:"Import" };
  return map[code] || "Manuale";
}

function sourceClass(code){
  const map = { manual:"", image:"info", sensor:"warn", import:"ok" };
  return map[code] || "";
}

function mediaCountForInspection(insp){
  const ids = insp?.mediaIds?.length || 0;
  return ids || (insp?.photoDataUrl ? 1 : 0);
}

function computeRiskForTrap(trapId){
  // Simple heuristic: last 7 days adults avg + larvae presence + temperature
  const insps = state.inspections.filter(i=>i.trapId===trapId).sort((a,b)=>a.date.localeCompare(b.date));
  if(insps.length === 0) return 0;

  const last7 = insps.slice(-7);
  const avgAdults = last7.reduce((s,i)=>s+i.adults,0)/Math.max(1,last7.length);
  const larvaeAny = last7.some(i=>i.larvae>0) ? 1 : 0;
  const avgTemp = last7.reduce((s,i)=>s+(Number(i.temperature)||0),0)/Math.max(1,last7.length);

  // normalize
  let score = 0;
  score += clamp((avgAdults/8)*60, 0, 60);
  score += larvaeAny ? 25 : 0;
  score += clamp(((avgTemp-18)/12)*15, 0, 15);
  return Math.round(score);
}

function render(){
  state.route = routeFromHash();
  setActiveNav(state.route);
  const view = $("#view");
  view.innerHTML = "";

  const route = state.route;
  if(route === "dashboard") view.appendChild(viewDashboard());
  else if(route === "map") view.appendChild(viewMap());
  else if(route === "traps") view.appendChild(viewTraps());
  else if(route === "inspections") view.appendChild(viewInspections());
  else if(route === "analytics") view.appendChild(viewAnalytics());
  else if(route === "alerts") view.appendChild(viewAlerts());
  else if(route === "messages") view.appendChild(viewMessages());
  else if(route === "settings") view.appendChild(viewSettings());
  else if(route === "about") view.appendChild(viewAbout());
  else view.appendChild(viewNotFound());

  setTimeout(()=> postRender(route), 0);
}

async function postRender(route){
  if(route === "map"){
    await ensureMap();
    drawMapMarkers();
  }
  if(route === "analytics"){
    drawCharts();
    const recalc = $("#btnRecalc");
    const suggest = $("#btnSuggest");
    if(recalc) recalc.textContent = "Ricalcola";
    if(suggest) suggest.textContent = "Suggerimenti";
  }
}

function viewDashboard(){
  const nearby = computeNearbyTraps();
  const totalTraps = state.traps.length;
  const totalInspections = state.inspections.length;

  const lastInspections = [...state.inspections].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6);
  const last7 = state.inspections.filter(i => i.date >= daysAgoISO(6));
  const avgAdults = last7.length ? (last7.reduce((s,i)=>s+i.adults,0)/last7.length) : 0;
  const larvaeHits = last7.filter(i=>i.larvae>0).length;

  const el = document.createElement("div");
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi">
        <div class="label">Trappole registrate</div>
        <div class="value">${totalTraps}</div>
        <div class="hint">Gestione anagrafiche e stato</div>
      </div>
      <div class="kpi">
        <div class="label">Ispezioni totali</div>
        <div class="value">${totalInspections}</div>
        <div class="hint">Storico completo offline-first</div>
      </div>
      <div class="kpi">
        <div class="label">Media adulti (ultimi 7 gg)</div>
        <div class="value">${avgAdults.toFixed(1)}</div>
        <div class="hint">Indicatore di pressione</div>
      </div>
      <div class="kpi">
        <div class="label">Rilevazioni larve (ultimi 7 gg)</div>
        <div class="value">${larvaeHits}</div>
        <div class="hint">Evento “alta attenzione”</div>
      </div>
    </div>

    <div class="grid" style="margin-top:14px">
      <div class="card" style="grid-column: span 7">
        <div class="hd">
          <div>
            <h2>Azioni rapide</h2>
            <p>Setup in 2 minuti</p>
          </div>
        </div>
        <div class="bd">
          <div class="row">
            <button class="btn primary" id="dashAddTrap">Nuova trappola</button>
            <button class="btn" id="dashAddInspection">Nuova ispezione</button>
            <button class="btn" id="dashReport">Genera report</button>
            <button class="btn" id="dashNotif">Attiva notifiche</button>
            <button class="btn" id="dashWhatsapp">WhatsApp rapido</button>
          </div>
          <hr class="sep"/>
          <div class="mini">
            <b>Suggerimento:</b> premi <b>Posizione</b> in alto, vai su <b>Mappa</b> e vedrai le trappole vicine (badge a sinistra).
            Registra un'ispezione sopra soglia per vedere un alert + notifica.
          </div>
        </div>
      </div>

      <div class="card" style="grid-column: span 5">
        <div class="hd">
          <div>
            <h2>Trappole vicine</h2>
            <p>${state.position ? "Basato sulla tua posizione" : "Attiva la posizione per vedere vicinanza"}</p>
          </div>
          <button class="btn small" id="dashLocate">Aggiorna</button>
        </div>
        <div class="bd">
          ${nearby.length ? `
            <table class="table">
              <thead><tr><th>Nome</th><th>Distanza</th><th>Stato</th></tr></thead>
              <tbody>
                ${nearby.slice(0,5).map(t=>`
                  <tr data-trap="${t.id}" class="rowTrap">
                    <td>${escapeHtml(t.name)}</td>
                    <td>${Math.round(t.dist)} m</td>
                    <td><span class="pill ${t.status==="Attiva"?"ok":(t.status==="In manutenzione"?"warn":"") }">${escapeHtml(t.status)}</span></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          ` : `<div class="mini">Nessuna trappola nel raggio configurato (${state.settings.nearRadiusM} m).<br/>Tip: aggiungi una trappola usando “Usa posizione attuale”.</div>`}
        </div>
      </div>

      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Ultime ispezioni</h2>
            <p>Trend rapido e note operative</p>
          </div>
          <button class="btn small" id="dashGoInspections">Apri ispezioni</button>
        </div>
        <div class="bd">
          <table class="table">
            <thead><tr><th>Data</th><th>Trappola</th><th>Adulti</th><th>Femmine</th><th>Larve</th><th>Note</th></tr></thead>
            <tbody>
              ${lastInspections.map(i=>{
                const t = state.traps.find(x=>x.id===i.trapId);
                const risk = i.larvae>0 ? "danger" : (i.adults>=5 ? "warn" : "ok");
                return `
                  <tr>
                    <td>${formatDate(i.date)}</td>
                    <td>${escapeHtml(t? t.name : "—")}</td>
                    <td><span class="pill ${risk}">${i.adults}</span></td>
                    <td>${i.females}</td>
                    <td>${i.larvae}</td>
                    <td>${escapeHtml(i.notes||"")}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // actions
  el.querySelector("#dashAddTrap").onclick = ()=> openTrapModal();
  el.querySelector("#dashAddInspection").onclick = ()=> openInspectionModal();
  el.querySelector("#dashReport").onclick = ()=> openReportModal();
  el.querySelector("#dashNotif").onclick = ()=> requestNotifications();
  el.querySelector("#dashWhatsapp").onclick = ()=> openWhatsApp(buildQuickUpdateText());
  el.querySelector("#dashLocate").onclick = async ()=> { await requestLocation(); render(); };
  el.querySelector("#dashGoInspections").onclick = ()=> location.hash="#/inspections";
  $$(".rowTrap", el).forEach(r=> r.onclick = ()=>{
    const id = r.getAttribute("data-trap");
    location.hash = "#/traps";
    setTimeout(()=> openTrapModal(state.traps.find(t=>t.id===id)), 0);
  });

  return el;
}

function viewMap(){
  const el = document.createElement("div");
  const nearby = computeNearbyTraps();

  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 8">
        <div class="hd">
          <div>
            <h2>Mappa trappole</h2>
            <p>Click marker per dettagli e ispezione rapida</p>
          </div>
          <div class="row">
            <button class="btn small" id="mapCenter">Centra</button>
            <button class="btn small" id="mapAdd">Aggiungi qui</button>
          </div>
        </div>
        <div class="bd">
          <div id="map" class="map"></div>
          <div class="mini" style="margin-top:10px">
            <b>Area base:</b> ${DEFAULT_SITE.name} (${DEFAULT_SITE.lat}, ${DEFAULT_SITE.lng}).<br/>
            <b>Nota:</b> le mappe usano tile online (Leaflet/OpenStreetMap). Se offline, la PWA resta usabile (CRUD + analytics), ma senza tile.
          </div>
        </div>
      </div>

      <div class="card" style="grid-column: span 4">
        <div class="hd">
          <div>
            <h2>Vicino a te</h2>
            <p>Raggio: ${state.settings.nearRadiusM} m</p>
          </div>
          <button class="btn small" id="mapLocate">Aggiorna</button>
        </div>
        <div class="bd">
          ${nearby.length ? `
            <table class="table">
              <thead><tr><th>Trappola</th><th>Distanza</th><th></th></tr></thead>
              <tbody>
                ${nearby.slice(0,8).map(t=>`
                  <tr>
                    <td>${escapeHtml(t.name)}</td>
                    <td>${Math.round(t.dist)} m</td>
                    <td><button class="btn small" data-open="${t.id}">Apri</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          ` : `<div class="mini">${state.position ? "Nessuna trappola vicina." : "Attiva la posizione per vedere vicinanza."}</div>`}
          <hr class="sep"/>
          <div class="mini">
            <b>Alert vicinanza:</b> quando apri l’app e sei vicino a una trappola attiva, puoi ricevere una notifica.
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelector("#mapLocate").onclick = async ()=> { await requestLocation(); render(); };
  el.querySelector("#mapCenter").onclick = ()=> centerMap();
  el.querySelector("#mapAdd").onclick = ()=> openTrapModal(null, { useMapCenter:true });

  $$("[data-open]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-open");
      const trap = state.traps.find(t=>t.id===id);
      openTrapModal(trap);
    };
  });

  return el;
}

function viewTraps(){
  const traps = applySearchFilter(state.traps, ["name","code","type","bait","status","notes","tags"]);
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Trappole</h2>
            <p>Anagrafiche, coordinate, stato e note</p>
          </div>
          <div class="row">
            <button class="btn" id="btnImport">Import JSON</button>
            <button class="btn" id="btnExport">Export JSON</button>
            <button class="btn primary" id="btnAddTrap">Nuova trappola</button>
          </div>
        </div>
        <div class="bd">
          <table class="table">
            <thead><tr>
              <th>Nome</th><th>Codice</th><th>Tipo</th><th>Stato</th><th>Ultima ispezione</th><th>Risk</th><th></th>
            </tr></thead>
            <tbody>
              ${traps.map(t=>{
                const last = lastInspectionForTrap(t.id);
                const score = computeRiskForTrap(t.id);
                const r = riskLabel(score);
                return `
                  <tr>
                    <td>${escapeHtml(t.name)}</td>
                    <td>${escapeHtml(t.code||"")}</td>
                    <td>${escapeHtml(t.type||"")}</td>
                    <td><span class="pill ${t.status==="Attiva"?"ok":(t.status==="In manutenzione"?"warn":"") }">${escapeHtml(t.status||"")}</span></td>
                    <td>${last ? formatDate(last.date) : "—"}</td>
                    <td><span class="pill ${r.cls}">${r.label} • ${score}</span></td>
                    <td style="text-align:right">
                      <button class="btn small" data-edit="${t.id}">Apri</button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
          ${traps.length===0 ? `<div class="mini">Nessun risultato per la ricerca corrente.</div>` : ""}
        </div>
      </div>
    </div>
  `;

  el.querySelector("#btnAddTrap").onclick = ()=> openTrapModal();
  el.querySelector("#btnExport").onclick = ()=> exportData();
  el.querySelector("#btnImport").onclick = ()=> importData();
  $$("[data-edit]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-edit");
      openTrapModal(state.traps.find(t=>t.id===id));
    };
  });

  return el;
}

function viewInspections(){
  const items = applySearchFilter([...state.inspections].sort((a,b)=>b.date.localeCompare(a.date)), ["notes","operator","date","source","sourceRef","sourceNote"]);
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Ispezioni</h2>
            <p>Catture, condizioni e note operative</p>
          </div>
          <div class="row">
            <button class="btn" id="btnReport">Report</button>
            <button class="btn primary" id="btnAddInspection">Nuova ispezione</button>
          </div>
        </div>
        <div class="bd">
          <table class="table">
            <thead><tr>
              <th>Data</th><th>Trappola</th><th>Adulti</th><th>Femmine</th><th>Larve</th><th>Meteo</th><th>Fonte</th><th>Media</th><th>Note</th><th></th>
            </tr></thead>
            <tbody>
              ${items.map(i=>{
                const t = state.traps.find(x=>x.id===i.trapId);
                const risk = i.larvae>0 ? "danger" : (i.adults>=5 ? "warn" : "ok");
                const meteo = `${i.temperature ?? "—"}°C • ${i.humidity ?? "—"}% • ${i.wind ?? "—"} km/h`;
                const source = sourceLabel(i.source);
                const sourceCls = sourceClass(i.source);
                const sourceRef = i.sourceRef ? `<div class="mini">${escapeHtml(i.sourceRef)}</div>` : "";
                const mediaCount = mediaCountForInspection(i);
                const mediaBtn = mediaCount ? `<button class="btn small" data-media="${i.id}">Foto (${mediaCount})</button>` : `<span class="mini">—</span>`;
                return `
                  <tr>
                    <td>${formatDate(i.date)}</td>
                    <td>${escapeHtml(t? t.name : "—")}</td>
                    <td><span class="pill ${risk}">${i.adults}</span></td>
                    <td>${i.females}</td>
                    <td>${i.larvae}</td>
                    <td>${escapeHtml(meteo)}</td>
                    <td><span class="pill ${sourceCls}">${source}</span>${sourceRef}</td>
                    <td>${mediaBtn}</td>
                    <td>${escapeHtml(i.notes||"")}</td>
                    <td style="text-align:right"><button class="btn small" data-open="${i.id}">Apri</button></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  el.querySelector("#btnAddInspection").onclick = ()=> openInspectionModal();
  el.querySelector("#btnReport").onclick = ()=> openReportModal();
  $$("[data-open]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-open");
      const i = state.inspections.find(x=>x.id===id);
      openInspectionModal(i);
    };
  });
  $$("[data-media]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-media");
      const i = state.inspections.find(x=>x.id===id);
      if(i) openMediaModal(i);
    };
  });
  return el;
}

function viewAnalytics(){
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 6">
        <div class="hd">
          <div>
            <h2>Trend settimanale</h2>
            <p>Somma adulti (ultimi 28 gg)</p>
          </div>
          <button class="btn small" id="btnRecalc">↻ Ricalcola</button>
        </div>
        <div class="bd">
          <canvas id="chWeekly" height="180"></canvas>
        </div>
      </div>

      <div class="card" style="grid-column: span 6">
        <div class="hd">
          <div>
            <h2>Contributo per trappola</h2>
            <p>Somma adulti (ultimi 14 gg)</p>
          </div>
        </div>
        <div class="bd">
          <canvas id="chByTrap" height="180"></canvas>
        </div>
      </div>

      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Rischio (euristica)</h2>
            <p>Adulti + Larve + Temperatura (ultimi 7 gg)</p>
          </div>
          <button class="btn small" id="btnSuggest">💡 Suggerimenti</button>
        </div>
        <div class="bd">
          <div class="split">
            <div>
              <canvas id="chRisk" height="170"></canvas>
            </div>
            <div>
              <div id="riskTable"></div>
              <hr class="sep"/>
              <div class="mini" id="suggestBox"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  el.querySelector("#btnRecalc").onclick = ()=> drawCharts();
  el.querySelector("#btnSuggest").onclick = ()=> renderSuggestions();
  return el;
}

function viewAlerts(){
  const alerts = applySearchFilter(state.alerts, ["name","metric","note"]);
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Alert & regole</h2>
            <p>Soglie su ispezioni e vicinanza</p>
          </div>
          <div class="row">
            <button class="btn" id="btnEnableNotif">Attiva notifiche</button>
            <button class="btn primary" id="btnAddAlert">Nuova regola</button>
          </div>
        </div>
        <div class="bd">
          <table class="table">
            <thead><tr><th>Nome</th><th>Metrica</th><th>Soglia</th><th>Attiva</th><th>Note</th><th></th></tr></thead>
            <tbody>
              ${alerts.map(a=>`
                <tr>
                  <td>${escapeHtml(a.name)}</td>
                  <td>${escapeHtml(a.metric)}</td>
                  <td>${escapeHtml(String(a.threshold))}</td>
                  <td>${a.active ? `<span class="pill ok">ON</span>` : `<span class="pill">OFF</span>`}</td>
                  <td>${escapeHtml(a.note||"")}</td>
                  <td style="text-align:right">
                    <button class="btn small" data-edit="${a.id}">Apri</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  el.querySelector("#btnAddAlert").onclick = ()=> openAlertModal();
  el.querySelector("#btnEnableNotif").onclick = ()=> requestNotifications();
  $$("[data-edit]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-edit");
      openAlertModal(state.alerts.find(a=>a.id===id));
    };
  });
  return el;
}

function viewMessages(){
  const msgs = applySearchFilter([...state.messages].sort((a,b)=>b.date.localeCompare(a.date)), ["title","body","channel","tags"]);
  const pendingOutbox = state.outbox
    .filter(o=>o.channel==="whatsapp" && o.status!=="sent")
    .sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Notifiche WhatsApp</h2>
            <p>Coda invii (richiede azione manuale)</p>
          </div>
          <div class="row">
            <button class="btn" id="btnOutboxClear">Svuota coda</button>
          </div>
        </div>
        <div class="bd">
          ${pendingOutbox.length ? pendingOutbox.map(o=>`
            <div class="outbox-item">
              <div>
                <div style="font-weight:700">${escapeHtml(o.title)}</div>
                <div class="mini">${new Date(o.createdAt||Date.now()).toLocaleString("it-IT")}</div>
                <div class="outbox-body">${escapeHtml(o.body||"").replaceAll("\n","<br/>")}</div>
              </div>
              <div class="row">
                <button class="btn small" data-outbox-send="${o.id}">Invia</button>
                <button class="btn small danger" data-outbox-del="${o.id}">Rimuovi</button>
              </div>
            </div>
          `).join("") : `<div class="mini">Nessuna notifica WhatsApp in coda.</div>`}
        </div>
      </div>

      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Comunicazioni</h2>
            <p>Log condivisibile (team, agronomo, cooperativa)</p>
          </div>
          <div class="row">
            <button class="btn" id="btnShareLog">Condividi log</button>
            <button class="btn" id="btnShareLogWhatsapp">WhatsApp log</button>
            <button class="btn primary" id="btnAddMsg">Nuovo messaggio</button>
          </div>
        </div>
        <div class="bd">
          ${msgs.length ? msgs.map(m=>`
            <div style="padding:12px; border-radius:16px; border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.02); margin-bottom:10px">
              <div style="display:flex; justify-content:space-between; gap:10px">
                <div>
                  <div style="font-weight:700">${escapeHtml(m.title)}</div>
                  <div class="mini">${escapeHtml(m.channel)} - ${new Date(m.date).toLocaleString("it-IT")}</div>
                </div>
                <div>
                  <button class="btn small" data-open="${m.id}">Apri</button>
                  <button class="btn small" data-wa="${m.id}">WhatsApp</button>
                </div>
              </div>
              <div style="margin-top:10px; color:rgba(31,42,31,.92)">${escapeHtml(m.body).replaceAll("\n","<br/>")}</div>
              ${m.tags?.length ? `<div style="margin-top:10px">${m.tags.map(t=>`<span class="pill">${escapeHtml(t)}</span>`).join(" ")}</div>` : ""}
            </div>
          `).join("") : `<div class="mini">Nessun messaggio. Usa "Nuovo messaggio".</div>`}
        </div>
      </div>
    </div>
  `;

  el.querySelector("#btnAddMsg").onclick = ()=> openMessageModal();
  el.querySelector("#btnShareLog").onclick = ()=> shareLog();
  el.querySelector("#btnShareLogWhatsapp").onclick = ()=> shareLogWhatsApp();
  el.querySelector("#btnOutboxClear").onclick = async ()=>{
    if(!pendingOutbox.length) return;
    if(!confirm("Svuotare la coda WhatsApp?")) return;
    for(const o of pendingOutbox) await DB.delete("outbox", o.id);
    await loadAll();
    render();
  };
  $$("[data-outbox-send]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-outbox-send");
      const item = state.outbox.find(o=>o.id===id);
      if(item) openWhatsappSendModal(item);
    };
  });
  $$("[data-outbox-del]", el).forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute("data-outbox-del");
      await DB.delete("outbox", id);
      await loadAll();
      render();
    };
  });
  $$("[data-open]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-open");
      openMessageModal(state.messages.find(m=>m.id===id));
    };
  });
  $$("[data-wa]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute("data-wa");
      const m = state.messages.find(x=>x.id===id);
      if(!m) return;
      openWhatsApp(`[${m.channel}] ${m.title}\n${m.body}`);
    };
  });
  return el;
}

function viewSettings(){
  const el = document.createElement("div");
  const contacts = state.settings.contacts || [];
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 8">
        <div class="hd">
          <div>
            <h2>Impostazioni</h2>
            <p>Comportamento, soglie e offline</p>
          </div>
          <button class="btn small danger" id="btnReset">Ripristina dati</button>
        </div>
        <div class="bd">
          <div class="row">
            <div class="field">
              <label>Raggio vicinanza (m)</label>
              <input id="nearRadius" type="number" min="50" step="10" value="${state.settings.nearRadiusM}" />
            </div>
            <div class="field">
              <label>Soglia default (adulti)</label>
              <input id="defaultThreshold" type="number" min="1" step="1" value="${state.settings.defaultThreshold}" />
            </div>
            <div class="field">
              <label>WhatsApp (numero opzionale)</label>
              <input id="whatsNumber" value="${escapeHtml(state.settings.whatsappNumber||"")}" placeholder="Es. 393331112233" />
            </div>
          </div>
          <div class="row" style="margin-top:12px">
            <div class="field">
              <label>Alert vicinanza</label>
              <select id="enableNearby">
                <option value="true" ${state.settings.enableNearbyAlert ? "selected":""}>Attivo</option>
                <option value="false" ${!state.settings.enableNearbyAlert ? "selected":""}>Disattivo</option>
              </select>
            </div>
            <div class="field">
              <label>Meteo (Open-Meteo, no-key)</label>
              <select id="enableWeather">
                <option value="true" ${state.settings.enableWeather ? "selected":""}>Attivo</option>
                <option value="false" ${!state.settings.enableWeather ? "selected":""}>Disattivo</option>
              </select>
            </div>
          </div>
          <div class="row" style="margin-top:12px">
            <div class="field">
              <label>WhatsApp su alert</label>
              <select id="enableWhatsappAlerts">
                <option value="true" ${state.settings.enableWhatsappAlerts ? "selected":""}>Attivo</option>
                <option value="false" ${!state.settings.enableWhatsappAlerts ? "selected":""}>Disattivo</option>
              </select>
            </div>
            <div class="field">
              <label>WhatsApp su vicinanza</label>
              <select id="enableWhatsappNearby">
                <option value="true" ${state.settings.enableWhatsappNearby ? "selected":""}>Attivo</option>
                <option value="false" ${!state.settings.enableWhatsappNearby ? "selected":""}>Disattivo</option>
              </select>
            </div>
          </div>
          <hr class="sep"/>
          <div class="row">
            <button class="btn" id="btnNotif">Notifiche</button>
            <button class="btn" id="btnOffline">Cache offline</button>
            <button class="btn primary" id="btnSaveSettings">Salva</button>
          </div>
          <div class="mini" style="margin-top:12px">
            <b>Nota:</b> le notifiche push in background richiedono un backend. Qui usiamo Notification API quando l'app e aperta.
            Le notifiche WhatsApp finiscono in coda e vanno inviate manualmente.
          </div>
        </div>
      </div>

      <div class="card" style="grid-column: span 4">
        <div class="hd">
          <div>
            <h2>Esportazione & backup</h2>
            <p>JSON locale</p>
          </div>
        </div>
        <div class="bd">
          <button class="btn" id="btnExportAll">Export completo</button>
          <button class="btn" style="margin-left:10px" id="btnImportAll">Import</button>
          <hr class="sep"/>
          <div class="mini">
            Esporta per inviare il backup a un agronomo o caricare su un server.
            Usa export completo per backup e trasferimenti tra dispositivi.
          </div>
        </div>
      </div>

      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Contatti WhatsApp</h2>
            <p>Numeri rapidi per invio aggiornamenti</p>
          </div>
        </div>
        <div class="bd">
          <div class="row">
            <div class="field">
              <label>Nome</label>
              <input id="cName" placeholder="Es. Mario Rossi" />
            </div>
            <div class="field">
              <label>Ruolo</label>
              <input id="cRole" placeholder="Es. Agronomo" />
            </div>
            <div class="field">
              <label>Telefono</label>
              <input id="cPhone" placeholder="Es. 393331112233" />
            </div>
            <div class="field" style="align-self:flex-end">
              <button class="btn primary" id="cAdd">Aggiungi contatto</button>
            </div>
          </div>

          <div style="margin-top:12px">
            ${contacts.length ? `
              <table class="table">
                <thead><tr><th>Nome</th><th>Ruolo</th><th>Telefono</th><th></th></tr></thead>
                <tbody>
                  ${contacts.map(c=>`
                    <tr>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${escapeHtml(c.role||"")}</td>
                      <td>${escapeHtml(c.phone)}</td>
                      <td style="text-align:right">
                        <button class="btn small" data-wa="${escapeHtml(c.phone)}">WhatsApp</button>
                        <button class="btn small danger" data-del="${escapeHtml(c.phone)}">Rimuovi</button>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            ` : `<div class="mini">Nessun contatto salvato.</div>`}
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelector("#btnSaveSettings").onclick = async ()=>{
    state.settings.nearRadiusM = Number($("#nearRadius").value || 200);
    state.settings.defaultThreshold = Number($("#defaultThreshold").value || 5);
    state.settings.whatsappNumber = $("#whatsNumber").value.trim();
    state.settings.enableNearbyAlert = $("#enableNearby").value === "true";
    state.settings.enableWeather = $("#enableWeather").value === "true";
    state.settings.enableWhatsappAlerts = $("#enableWhatsappAlerts").value === "true";
    state.settings.enableWhatsappNearby = $("#enableWhatsappNearby").value === "true";
    await DB.setSetting("app_settings", state.settings);
    toast("Salvato", "Impostazioni aggiornate.");
    updateBadges();
    render();
  };
  el.querySelector("#btnNotif").onclick = ()=> requestNotifications();
  el.querySelector("#btnOffline").onclick = ()=> toast("Offline", "Apri la PWA una volta: l'app shell viene cachata automaticamente.");
  el.querySelector("#btnReset").onclick = ()=> resetData();
  el.querySelector("#btnExportAll").onclick = ()=> exportData(true);
  el.querySelector("#btnImportAll").onclick = ()=> importData(true);

  const addBtn = $("#cAdd");
  if(addBtn){
    addBtn.onclick = async ()=>{
      const name = $("#cName").value.trim();
      const role = $("#cRole").value.trim();
      const phone = cleanPhoneNumber($("#cPhone").value.trim());
      if(!name || !phone){ toast("Dati mancanti", "Nome e telefono sono obbligatori."); return; }
      const next = [...contacts.filter(c=>c.phone!==phone), { name, role, phone }];
      state.settings.contacts = next;
      await DB.setSetting("app_settings", state.settings);
      toast("Salvato", "Contatto aggiunto.");
      render();
    };
  }
  $$("[data-wa]", el).forEach(btn=>{
    btn.onclick = ()=>{
      const phone = btn.getAttribute("data-wa");
      if(!phone) return;
      const text = buildQuickUpdateText();
      openWhatsApp(text, phone);
    };
  });
  $$("[data-del]", el).forEach(btn=>{
    btn.onclick = async ()=>{
      const phone = btn.getAttribute("data-del");
      state.settings.contacts = contacts.filter(c=>c.phone!==phone);
      await DB.setSetting("app_settings", state.settings);
      toast("Rimosso", "Contatto eliminato.");
      render();
    };
  });

  return el;
}

function viewAbout(){
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="grid">
      <div class="card" style="grid-column: span 12">
        <div class="hd">
          <div>
            <h2>Info</h2>
            <p>Uso operativo e requisiti</p>
          </div>
        </div>
        <div class="bd">
          <div class="split">
            <div>
              <div style="font-weight:700; margin-bottom:8px">Cosa fa questa app</div>
              <ul class="mini">
                <li>CRUD trappole con coordinate + mappa</li>
                <li>Ispezioni con catture, condizioni meteo, note</li>
                <li>Alert su soglie + vicinanza</li>
                <li>Analytics (Chart.js) + rischio euristico</li>
                <li>Report condivisibile (Web Share / Clipboard)</li>
                <li>Offline-first (IndexedDB) + PWA installabile</li>
              </ul>
            </div>
            <div>
              <div style="font-weight:700; margin-bottom:8px">Requisiti tecnici</div>
              <ul class="mini">
                <li>Mappa online: richiede connettivita per le tile</li>
                <li>Notifiche push: per background serve backend dedicato</li>
                <li>WhatsApp: richiede app installata o WhatsApp Web</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  return el;
}

function viewNotFound(){
  const el = document.createElement("div");
  el.innerHTML = `<div class="card"><div class="bd">Pagina non trovata.</div></div>`;
  return el;
}

// ---------- Map ----------
async function ensureMap(){
  if(state.map.obj) return;
  const pos = state.position || { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng };
  const map = L.map("map", { zoomControl: true }).setView([pos.lat, pos.lng], 13);
  state.map.obj = map;

  try{
    const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    });
    tiles.addTo(map);
    state.map.layer = tiles;
  }catch(e){
    // ignore
  }

  // Long press / right click add
  map.on("contextmenu", (e)=>{
    openTrapModal(null, { lat:e.latlng.lat, lng:e.latlng.lng });
  });
}

function drawMapMarkers(){
  if(!state.map.obj) return;
  // cleanup
  for(const m of state.map.markers) m.remove();
  state.map.markers = [];

  for(const t of state.traps){
    const color = t.status==="Attiva" ? "#6A7F47" : (t.status==="In manutenzione" ? "#C39A4D" : "#8C9A85");
    const marker = L.circleMarker([t.lat, t.lng], { radius: 9, color, fillColor: color, fillOpacity: 0.85, weight: 2 });
    marker.addTo(state.map.obj);
    marker.on("click", ()=> openTrapModal(t));
    marker.bindTooltip(`${t.name}`, { direction:"top", offset:[0,-8], opacity:0.95 });
    state.map.markers.push(marker);
  }

  // user location
  if(state.position){
    const m = L.circleMarker([state.position.lat, state.position.lng], { radius: 9, color:"#5D7D8A", fillColor:"#5D7D8A", fillOpacity: 0.85, weight: 2 });
    m.addTo(state.map.obj);
    m.bindTooltip("Tu sei qui", { direction:"top", offset:[0,-8] });
    state.map.markers.push(m);
  }
}

function centerMap(){
  if(!state.map.obj) return;
  const pos = state.position || { lat: DEFAULT_SITE.lat, lng: DEFAULT_SITE.lng };
  state.map.obj.setView([pos.lat, pos.lng], 14);
}

// ---------- Utils ----------
function daysAgoISO(n){
  const d = new Date();
  d.setDate(d.getDate()-n);
  return d.toISOString().slice(0,10);
}

function lastInspectionForTrap(trapId){
  const insps = state.inspections.filter(i=>i.trapId===trapId);
  if(insps.length===0) return null;
  return insps.sort((a,b)=>b.date.localeCompare(a.date))[0];
}

function toCSV(rows){
  const esc = (v) => `"${String(v??"").replaceAll('"','""')}"`;
  const keys = Object.keys(rows[0]||{});
  return [keys.map(esc).join(","), ...rows.map(r=>keys.map(k=>esc(r[k])).join(","))].join("\n");
}

// ---------- Modals ----------
function openModal({title, bodyHTML, footerButtons=[]}){
  const root = $("#modalRoot");
  root.classList.remove("hidden");
  root.innerHTML = `
    <div class="modal-backdrop" id="mb">
      <div class="modal">
        <div class="hd">
          <h3>${escapeHtml(title)}</h3>
          <button class="btn small" id="mClose">Chiudi</button>
        </div>
        <div class="bd">${bodyHTML}</div>
        <div class="ft">
          ${footerButtons.map(b=>`<button class="btn ${b.kind||""}" id="${b.id}">${escapeHtml(b.label)}</button>`).join("")}
        </div>
      </div>
    </div>
  `;
  $("#mClose").onclick = closeModal;
  $("#mb").onclick = (e)=>{ if(e.target.id==="mb") closeModal(); };
  return root;
}
function closeModal(){
  const root = $("#modalRoot");
  root.classList.add("hidden");
  root.innerHTML = "";
}

async function openTrapModal(trap=null, opts={}){
  const isEdit = !!trap;
  const p = state.position;

  const useMapCenter = opts.useMapCenter && state.map.obj;
  const center = useMapCenter ? state.map.obj.getCenter() : null;
  const lat = opts.lat ?? (center ? center.lat : (trap?.lat ?? p?.lat ?? DEFAULT_SITE.lat));
  const lng = opts.lng ?? (center ? center.lng : (trap?.lng ?? p?.lng ?? DEFAULT_SITE.lng));

  const body = `
    <div class="split">
      <div>
        <div class="row">
          <div class="field">
            <label>Nome</label>
            <input id="tName" value="${escapeHtml(trap?.name||"")}" placeholder="Es. Trappola Nord - Coratina" />
          </div>
          <div class="field">
            <label>Codice</label>
            <input id="tCode" value="${escapeHtml(trap?.code||"")}" placeholder="Es. A-001" />
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Tipo</label>
            <select id="tType">
              ${["Cromotropica","Feromonica","Altro"].map(x=>`<option ${trap?.type===x?"selected":""}>${x}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Esca/Attrattivo</label>
            <input id="tBait" value="${escapeHtml(trap?.bait||"")}" placeholder="Es. Feromone + ammonio" />
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Latitudine</label>
            <input id="tLat" type="number" step="0.000001" value="${lat}" />
          </div>
          <div class="field">
            <label>Longitudine</label>
            <input id="tLng" type="number" step="0.000001" value="${lng}" />
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Data installazione</label>
            <input id="tInstall" type="date" value="${trap?.installDate||todayISO()}" />
          </div>
          <div class="field">
            <label>Stato</label>
            <select id="tStatus">
              ${["Attiva","In manutenzione","Dismessa"].map(x=>`<option ${trap?.status===x?"selected":""}>${x}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="field" style="margin-top:12px">
          <label>Tag (separati da virgola)</label>
          <input id="tTags" value="${escapeHtml((trap?.tags||[]).join(", "))}" placeholder="Es. coratina, collina, irrigato" />
        </div>

        <div class="field" style="margin-top:12px">
          <label>Note</label>
          <textarea id="tNotes" placeholder="Note operative, manutenzione, contesto...">${escapeHtml(trap?.notes||"")}</textarea>
        </div>
      </div>

      <div>
        <div style="font-weight:700; margin-bottom:8px">Azioni</div>
        <div class="row">
          <button class="btn" id="tUsePos">Usa posizione</button>
          <button class="btn" id="tInspect">Ispezione</button>
          <button class="btn" id="tRoute">Naviga</button>
          <button class="btn" id="tCopyCoords">Copia coordinate</button>
        </div>
        <hr class="sep"/>
        <div class="mini">
          <b>Geolocalizzazione:</b> “Usa posizione” inserisce la tua posizione attuale nei campi Lat/Lng.<br/>
          <b>Naviga:</b> apre Google Maps in modalità indicazioni.
        </div>
        <hr class="sep"/>
        <div style="font-weight:700; margin-bottom:8px">Rischio</div>
        <div class="mini" id="tRiskBox"></div>
        <hr class="sep"/>
        <div style="font-weight:700; margin-bottom:8px">Ultima ispezione</div>
        <div class="mini" id="tLastBox"></div>
      </div>
    </div>
  `;

  const footer = [
    ...(isEdit ? [{ id:"tDelete", label:"Elimina", kind:"danger" }] : []),
    { id:"tCancel", label:"Annulla" },
    { id:"tSave", label: isEdit ? "Salva" : "Crea", kind:"primary" }
  ];

  openModal({ title: isEdit ? "Trappola" : "Nuova trappola", bodyHTML: body, footerButtons: footer });

  // Fill side panels
  const score = trap ? computeRiskForTrap(trap.id) : 0;
  const r = riskLabel(score);
  $("#tRiskBox").innerHTML = trap ? `
    <span class="pill ${r.cls}">Rischio ${r.label} • ${score}</span><br/>
    <span class="mini">Euristica: ultimi 7 gg (adulti + larve + temp)</span>
  ` : `<span class="mini">Salva la trappola e registra ispezioni per calcolare il rischio.</span>`;

  const last = trap ? lastInspectionForTrap(trap.id) : null;
  $("#tLastBox").innerHTML = last ? `
    ${formatDate(last.date)} • Adulti: <b>${last.adults}</b> • Larve: <b>${last.larvae}</b><br/>
    <span class="mini">${escapeHtml(last.notes||"")}</span>
  ` : `<span class="mini">Nessuna ispezione.</span>`;

  $("#tCancel").onclick = closeModal;

  $("#tUsePos").onclick = async ()=>{
    const pos = await requestLocation();
    if(!pos) return;
    $("#tLat").value = pos.lat;
    $("#tLng").value = pos.lng;
  };

  $("#tInspect").onclick = ()=>{
    const tempTrap = trap || { id:"__temp__", name: $("#tName").value || "Nuova trappola" };
    closeModal();
    openInspectionModal(null, { preTrap: tempTrap, preLatLng: { lat: Number($("#tLat").value), lng: Number($("#tLng").value) } });
  };

  $("#tRoute").onclick = ()=>{
    const la = Number($("#tLat").value), lo = Number($("#tLng").value);
    const url = `https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`;
    window.open(url, "_blank");
  };
  $("#tCopyCoords").onclick = async ()=>{
    const la = Number($("#tLat").value), lo = Number($("#tLng").value);
    const text = `${la}, ${lo}`;
    try{
      await navigator.clipboard.writeText(text);
      toast("Copiato", "Coordinate copiate.");
    }catch(e){
      toast("Non supportato", "Copia manuale le coordinate.");
    }
  };

  if(isEdit){
    $("#tDelete").onclick = async ()=>{
      if(!confirm("Eliminare la trappola e le ispezioni collegate?")) return;
      await DB.delete("traps", trap.id);
      // cascade delete inspections
      const insps = state.inspections.filter(i=>i.trapId===trap.id);
      for(const i of insps){
        const mediaItems = await DB.indexGetAll("media", "by_inspectionId", i.id);
        for(const m of mediaItems) await DB.delete("media", m.id);
        await DB.delete("inspections", i.id);
      }
      toast("Eliminata", trap.name);
      await loadAll();
      closeModal();
      render();
    };
  }

  $("#tSave").onclick = async ()=>{
    const name = $("#tName").value.trim();
    if(!name){
      toast("Nome mancante", "Inserisci almeno il nome della trappola.");
      return;
    }
    const obj = {
      id: trap?.id || uid("trap"),
      name,
      code: $("#tCode").value.trim(),
      type: $("#tType").value,
      bait: $("#tBait").value.trim(),
      lat: Number($("#tLat").value),
      lng: Number($("#tLng").value),
      installDate: $("#tInstall").value,
      status: $("#tStatus").value,
      tags: $("#tTags").value.split(",").map(s=>s.trim()).filter(Boolean),
      notes: $("#tNotes").value.trim()
    };
    await DB.put("traps", obj);
    toast(isEdit ? "Salvata" : "Creata", obj.name);
    await loadAll();
    closeModal();
    render();
    if(state.route==="map") drawMapMarkers();
  };
}

async function openInspectionModal(inspection=null, opts={}){
  const isEdit = !!inspection;

  const preTrap = opts.preTrap || (inspection ? state.traps.find(t=>t.id===inspection.trapId) : null);

  const trapOptions = state.traps.map(t=>`<option value="${t.id}" ${inspection?.trapId===t.id ? "selected":""}>${escapeHtml(t.name)}</option>`).join("");
  const selectedTrapId = inspection?.trapId || preTrap?.id || (state.traps[0]?.id || "");
  const selectedTrap = state.traps.find(t=>t.id===selectedTrapId) || preTrap || null;
  const defaultSource = inspection?.source || ((inspection?.mediaIds?.length || inspection?.photoDataUrl) ? "image" : "manual");
  const sourceRef = inspection?.sourceRef || "";
  const sourceNote = inspection?.sourceNote || "";
  const sourcePayload = inspection?.sourcePayload || "";
  const payloadHidden = defaultSource === "sensor" ? "" : "hidden";
  const existingMedia = inspection?.mediaIds?.length
    ? (await Promise.all(inspection.mediaIds.map(id=>DB.get("media", id)))).filter(Boolean)
    : [];
  const legacyMedia = (!existingMedia.length && inspection?.photoDataUrl)
    ? [{ id:"legacy", dataUrl: inspection.photoDataUrl, legacy: true, filename: "Foto" }]
    : [];

  // Weather auto (optional)
  let weatherHint = "";
  if(state.settings.enableWeather && selectedTrap && navigator.onLine){
    weatherHint = `<span class="mini">Suggerimento: puoi compilare meteo automaticamente (Open-Meteo) dal pulsante.</span>`;
  }

  const body = `
    <div class="split">
      <div>
        <div class="row">
          <div class="field">
            <label>Trappola</label>
            <select id="iTrap">${trapOptions}</select>
          </div>
          <div class="field">
            <label>Data</label>
            <input id="iDate" type="date" value="${inspection?.date || todayISO()}" />
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Adulti</label>
            <input id="iAdults" type="number" min="0" step="1" value="${inspection?.adults ?? 0}" />
          </div>
          <div class="field">
            <label>Femmine (stima)</label>
            <input id="iFemales" type="number" min="0" step="1" value="${inspection?.females ?? 0}" />
          </div>
          <div class="field">
            <label>Larve</label>
            <input id="iLarvae" type="number" min="0" step="1" value="${inspection?.larvae ?? 0}" />
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Temperatura (°C)</label>
            <input id="iTemp" type="number" step="0.1" value="${inspection?.temperature ?? ""}" placeholder="Es. 26.5" />
          </div>
          <div class="field">
            <label>Umidità (%)</label>
            <input id="iHum" type="number" step="1" value="${inspection?.humidity ?? ""}" placeholder="Es. 62" />
          </div>
          <div class="field">
            <label>Vento (km/h)</label>
            <input id="iWind" type="number" step="1" value="${inspection?.wind ?? ""}" placeholder="Es. 8" />
          </div>
        </div>

        <div class="field" style="margin-top:12px">
          <label>Note</label>
          <textarea id="iNotes" placeholder="Osservazioni, manutenzione, eventuale trattamento...">${escapeHtml(inspection?.notes||"")}</textarea>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Operatore</label>
            <input id="iOp" value="${escapeHtml(inspection?.operator||"")}" placeholder="Es. Pietro" />
          </div>
          <div class="field">
            <label>Foto (opzionale)</label>
            <input id="iPhoto" type="file" accept="image/*" capture="environment" multiple />
            <div class="media-list" id="iMediaList"></div>
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field">
            <label>Metodo acquisizione</label>
            <select id="iSource">
              <option value="manual" ${defaultSource==="manual" ? "selected":""}>Manuale</option>
              <option value="image" ${defaultSource==="image" ? "selected":""}>Foto</option>
              <option value="sensor" ${defaultSource==="sensor" ? "selected":""}>Sensore/IoT</option>
              <option value="import" ${defaultSource==="import" ? "selected":""}>Import</option>
            </select>
          </div>
          <div class="field">
            <label>Riferimento (opzionale)</label>
            <input id="iSourceRef" value="${escapeHtml(sourceRef)}" placeholder="Es. CAM-12, CSV-2025-02" />
          </div>
        </div>

        <div class="field" style="margin-top:12px">
          <label>Note acquisizione (opzionale)</label>
          <textarea id="iSourceNote" placeholder="Dettagli su foto, sensori o import...">${escapeHtml(sourceNote)}</textarea>
        </div>

        <div class="field ${payloadHidden}" style="margin-top:12px" id="iSourcePayloadWrap">
          <label>Payload sensore (opzionale)</label>
          <textarea id="iSourcePayload" placeholder='Es. {"adults":4,"temp":25.1}'>${escapeHtml(sourcePayload)}</textarea>
        </div>
      </div>

      <div>
        <div style="font-weight:700; margin-bottom:8px">Azioni</div>
        <div class="row">
          <button class="btn" id="iAutoFem">Stima femmine</button>
          <button class="btn" id="iWeather">Meteo</button>
          <button class="btn" id="iCheckAlerts">Verifica alert</button>
        </div>
        <hr class="sep"/>
        ${weatherHint}
        <div class="mini" id="iTrapInfo"></div>
        <hr class="sep"/>
        <div style="font-weight:700; margin-bottom:8px">Rischio attuale trappola</div>
        <div class="mini" id="iRiskNow"></div>
      </div>
    </div>
  `;

  const footer = [
    ...(isEdit ? [{ id:"iDelete", label:"Elimina", kind:"danger" }] : []),
    { id:"iCancel", label:"Annulla" },
    { id:"iSave", label: isEdit ? "Salva" : "Registra", kind:"primary" }
  ];

  openModal({ title: isEdit ? "Ispezione" : "Nuova ispezione", bodyHTML: body, footerButtons: footer });

  function refreshSide(){
    const trapId = $("#iTrap").value;
    const t = state.traps.find(x=>x.id===trapId);
    $("#iTrapInfo").innerHTML = t ? `
      <b>${escapeHtml(t.name)}</b><br/>
      ${escapeHtml(t.type||"")} • ${escapeHtml(t.bait||"")}<br/>
      Stato: <span class="pill ${t.status==="Attiva"?"ok":(t.status==="In manutenzione"?"warn":"")}">${escapeHtml(t.status||"")}</span><br/>
      <span class="mini">Lat/Lng: ${t.lat.toFixed(6)}, ${t.lng.toFixed(6)}</span>
    ` : `<span class="mini">Seleziona una trappola.</span>`;

    if(t){
      const score = computeRiskForTrap(t.id);
      const r = riskLabel(score);
      $("#iRiskNow").innerHTML = `<span class="pill ${r.cls}">Rischio ${r.label} • ${score}</span>`;
    }else{
      $("#iRiskNow").innerHTML = `<span class="mini">—</span>`;
    }
  }
  refreshSide();
  $("#iTrap").onchange = refreshSide;

  const pendingMedia = [];
  const removedMediaIds = new Set();
  const mediaList = $("#iMediaList");
  function renderMediaList(){
    if(!mediaList) return;
    const activeExisting = [...existingMedia, ...legacyMedia].filter(m=>!removedMediaIds.has(m.id));
    if(!activeExisting.length && !pendingMedia.length){
      mediaList.innerHTML = `<div class="mini">Nessuna foto allegata.</div>`;
      return;
    }
    const cards = [];
    for(const m of activeExisting){
      cards.push(`
        <div class="media-card">
          <img class="media-thumb" src="${m.dataUrl}" alt="Foto ispezione" />
          <div class="media-meta">
            <div>${escapeHtml(m.filename || "Foto")}</div>
            <button class="btn small danger" data-remove-media="${m.id}">Rimuovi</button>
          </div>
        </div>
      `);
    }
    pendingMedia.forEach((m, idx)=>{
      cards.push(`
        <div class="media-card pending">
          <img class="media-thumb" src="${m.dataUrl}" alt="Nuova foto" />
          <div class="media-meta">
            <div>${escapeHtml(m.filename || "Nuova foto")}</div>
            <button class="btn small danger" data-remove-pending="${idx}">Rimuovi</button>
          </div>
        </div>
      `);
    });
    mediaList.innerHTML = `<div class="media-grid small">${cards.join("")}</div>`;
  }
  renderMediaList();
  if(mediaList){
    mediaList.onclick = (e)=>{
      const btnExisting = e.target.closest("[data-remove-media]");
      const btnPending = e.target.closest("[data-remove-pending]");
      if(btnExisting){
        removedMediaIds.add(btnExisting.getAttribute("data-remove-media"));
        renderMediaList();
      }
      if(btnPending){
        const idx = Number(btnPending.getAttribute("data-remove-pending"));
        if(Number.isFinite(idx)) pendingMedia.splice(idx, 1);
        renderMediaList();
      }
    };
  }

  const sourceSelect = $("#iSource");
  const payloadWrap = $("#iSourcePayloadWrap");
  const updateSourceUI = ()=>{
    if(payloadWrap && sourceSelect){
      payloadWrap.classList.toggle("hidden", sourceSelect.value !== "sensor");
    }
  };
  if(sourceSelect){
    sourceSelect.onchange = updateSourceUI;
    updateSourceUI();
  }

  const photoInput = $("#iPhoto");
  if(photoInput){
    photoInput.onchange = async ()=>{
      const files = [...(photoInput.files || [])];
      for(const file of files){
        if(!file.type.startsWith("image/")) continue;
        const dataUrl = await fileToDataUrl(file);
        pendingMedia.push({ dataUrl, filename: file.name, size: file.size, type: file.type });
      }
      if(files.length && sourceSelect && sourceSelect.value === "manual"){
        sourceSelect.value = "image";
        updateSourceUI();
      }
      photoInput.value = "";
      renderMediaList();
    };
  }

  $("#iCancel").onclick = closeModal;

  if(isEdit){
    $("#iDelete").onclick = async ()=>{
      if(!confirm("Eliminare l'ispezione?")) return;
      const mediaItems = await DB.indexGetAll("media", "by_inspectionId", inspection.id);
      for(const m of mediaItems) await DB.delete("media", m.id);
      await DB.delete("inspections", inspection.id);
      toast("Eliminata", "Ispezione rimossa.");
      await loadAll();
      closeModal();
      render();
    };
  }

  $("#iAutoFem").onclick = ()=>{
    const a = Number($("#iAdults").value||0);
    const est = Math.round(a * 0.55);
    $("#iFemales").value = est;
    toast("Stima femmine", `Impostate a ${est} (55% degli adulti).`);
  };

  $("#iWeather").onclick = async ()=>{
    const trapId = $("#iTrap").value;
    const t = state.traps.find(x=>x.id===trapId);
    if(!t){ toast("Trappola mancante", "Seleziona una trappola."); return; }
    if(!navigator.onLine){ toast("Offline", "Connessione non disponibile."); return; }
    if(!state.settings.enableWeather){ toast("Meteo disattivato", "Attivalo in impostazioni."); return; }
    try{
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${t.lat}&longitude=${t.lng}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`;
      const res = await fetch(url);
      const j = await res.json();
      const c = j.current || {};
      if(c.temperature_2m != null) $("#iTemp").value = c.temperature_2m;
      if(c.relative_humidity_2m != null) $("#iHum").value = c.relative_humidity_2m;
      if(c.wind_speed_10m != null) $("#iWind").value = c.wind_speed_10m;
      toast("Meteo compilato", "Dati correnti da Open-Meteo.");
    }catch(e){
      toast("Errore meteo", "Impossibile recuperare dati.");
    }
  };

  $("#iCheckAlerts").onclick = ()=>{
    const adults = Number($("#iAdults").value||0);
    const larvae = Number($("#iLarvae").value||0);
    const hit = [];
    for(const a of state.alerts.filter(x=>x.active)){
      if(a.metric==="adults" && adults >= Number(a.threshold)) hit.push(a);
      if(a.metric==="larvae" && larvae >= Number(a.threshold)) hit.push(a);
    }
    if(hit.length){
      toast("Alert potenziali", hit.map(h=>h.name).join(" • "));
    }else{
      toast("Nessun alert", "Valori sotto soglia.");
    }
  };

  $("#iSave").onclick = async ()=>{
    const trapId = $("#iTrap").value;
    if(!trapId){
      toast("Trappola mancante", "Seleziona una trappola.");
      return;
    }

    const inspId = inspection?.id || uid("insp");
    const source = $("#iSource").value || "manual";
    const sourceRefVal = $("#iSourceRef").value.trim();
    const sourceNoteVal = $("#iSourceNote").value.trim();
    const sourcePayloadVal = $("#iSourcePayload").value.trim();

    const keepExisting = existingMedia.filter(m=>!removedMediaIds.has(m.id));
    const removeExisting = existingMedia.filter(m=>removedMediaIds.has(m.id));
    for(const m of removeExisting){
      await DB.delete("media", m.id);
    }
    for(const m of keepExisting){
      if(m.trapId !== trapId || m.inspectionId !== inspId){
        await DB.put("media", { ...m, trapId, inspectionId: inspId });
      }
    }
    const mediaIds = keepExisting.map(m=>m.id);

    const legacyKeep = legacyMedia.filter(m=>!removedMediaIds.has(m.id));
    for(const m of legacyKeep){
      const mediaId = uid("media");
      await DB.put("media", {
        id: mediaId,
        inspectionId: inspId,
        trapId,
        kind: "image",
        dataUrl: m.dataUrl,
        createdAt: $("#iDate").value || new Date().toISOString(),
        note: "legacy-photo"
      });
      mediaIds.push(mediaId);
    }

    for(const m of pendingMedia){
      const mediaId = uid("media");
      await DB.put("media", {
        id: mediaId,
        inspectionId: inspId,
        trapId,
        kind: "image",
        dataUrl: m.dataUrl,
        filename: m.filename || "Foto",
        size: m.size,
        contentType: m.type,
        createdAt: new Date().toISOString()
      });
      mediaIds.push(mediaId);
    }

    const obj = {
      id: inspId,
      trapId,
      date: $("#iDate").value,
      adults: Number($("#iAdults").value||0),
      females: Number($("#iFemales").value||0),
      larvae: Number($("#iLarvae").value||0),
      temperature: $("#iTemp").value==="" ? null : Number($("#iTemp").value),
      humidity: $("#iHum").value==="" ? null : Number($("#iHum").value),
      wind: $("#iWind").value==="" ? null : Number($("#iWind").value),
      notes: $("#iNotes").value.trim(),
      operator: $("#iOp").value.trim(),
      source,
      sourceRef: sourceRefVal,
      sourceNote: sourceNoteVal,
      sourcePayload: sourcePayloadVal,
      mediaIds
    };

    await DB.put("inspections", obj);
    toast(isEdit ? "Salvata" : "Registrata", `Ispezione ${formatDate(obj.date)}`);

    await loadAll();
    closeModal();
    render();

    // Check alerts and notify
    await evaluateAlertsOnInspection(obj);
  };
}

async function openMediaModal(inspection){
  const t = state.traps.find(x=>x.id===inspection.trapId);
  let items = await DB.indexGetAll("media", "by_inspectionId", inspection.id);
  if(!items.length && inspection.photoDataUrl){
    items = [{ id:"legacy", kind:"image", dataUrl: inspection.photoDataUrl, createdAt: inspection.date }];
  }
  const title = `Media ispezione - ${t? t.name : "Trappola"}`;
  const body = items.length ? `
    <div class="media-grid">
      ${items.map(m=>`
        <div class="media-card">
          <img class="media-thumb" src="${m.dataUrl}" alt="Foto ispezione" />
          <div class="media-meta">
            <div>${escapeHtml(m.filename || "Foto")}</div>
            <div class="mini">${m.createdAt ? formatDate(m.createdAt) : ""}</div>
          </div>
        </div>
      `).join("")}
    </div>
  ` : `<div class="mini">Nessuna foto associata a questa ispezione.</div>`;
  openModal({
    title,
    bodyHTML: body,
    footerButtons: [{ id:"mediaClose", label:"Chiudi" }]
  });
  $("#mediaClose").onclick = closeModal;
}

async function openAlertModal(alert=null){
  const isEdit = !!alert;

  const body = `
    <div class="row">
      <div class="field">
        <label>Nome</label>
        <input id="aName" value="${escapeHtml(alert?.name||"")}" placeholder="Es. Soglia catture (adulti)" />
      </div>
      <div class="field">
        <label>Metrica</label>
        <select id="aMetric">
          ${["adults","larvae","nearby"].map(x=>`<option value="${x}" ${alert?.metric===x?"selected":""}>${x}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Soglia</label>
        <input id="aThr" type="number" step="1" value="${alert?.threshold ?? state.settings.defaultThreshold}" />
      </div>
    </div>

    <div class="row" style="margin-top:12px">
      <div class="field">
        <label>Attiva</label>
        <select id="aActive">
          <option value="true" ${(alert?.active ?? true) ? "selected":""}>ON</option>
          <option value="false" ${!(alert?.active ?? true) ? "selected":""}>OFF</option>
        </select>
      </div>
      <div class="field">
        <label>Scope</label>
        <select id="aScope">
          <option value="any" ${alert?.scope==="any"?"selected":""}>Qualsiasi trappola</option>
        </select>
      </div>
    </div>

    <div class="field" style="margin-top:12px">
      <label>Note</label>
      <textarea id="aNote" placeholder="Contesto e istruzioni operative...">${escapeHtml(alert?.note||"")}</textarea>
    </div>

    <div class="mini" style="margin-top:10px">
      <b>Metriche:</b><br/>
      <b>adults</b> = adulti catturati in una singola ispezione<br/>
      <b>larvae</b> = larve rilevate in una singola ispezione<br/>
      <b>nearby</b> = vicinanza (m) quando apri la PWA (richiede posizione)
    </div>
  `;

  const footer = [
    ...(isEdit ? [{ id:"aDelete", label:"Elimina", kind:"danger" }] : []),
    { id:"aCancel", label:"Annulla" },
    { id:"aSave", label: isEdit ? "Salva" : "Crea", kind:"primary" }
  ];

  openModal({ title: isEdit ? "Regola alert" : "Nuova regola", bodyHTML: body, footerButtons: footer });

  $("#aCancel").onclick = closeModal;
  if(isEdit){
    $("#aDelete").onclick = async ()=>{
      if(!confirm("Eliminare la regola?")) return;
      await DB.delete("alerts", alert.id);
      toast("Eliminata", alert.name);
      await loadAll();
      closeModal();
      render();
    };
  }
  $("#aSave").onclick = async ()=>{
    const name = $("#aName").value.trim();
    if(!name){ toast("Nome mancante", "Inserisci un nome regola."); return; }
    const obj = {
      id: alert?.id || uid("al"),
      name,
      metric: $("#aMetric").value,
      threshold: Number($("#aThr").value||0),
      active: $("#aActive").value === "true",
      scope: $("#aScope").value,
      note: $("#aNote").value.trim()
    };
    await DB.put("alerts", obj);
    toast(isEdit ? "Salvata" : "Creata", obj.name);
    await loadAll();
    closeModal();
    render();
  };
}

async function openMessageModal(msg=null){
  const isEdit = !!msg;
  const body = `
    <div class="row">
      <div class="field">
        <label>Canale</label>
        <select id="mChan">
          ${["Team","Agronomo","Cooperativa","Personale"].map(x=>`<option ${msg?.channel===x?"selected":""}>${x}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Titolo</label>
        <input id="mTitle" value="${escapeHtml(msg?.title||"")}" placeholder="Es. Allerta picco catture" />
      </div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>Messaggio</label>
      <textarea id="mBody" placeholder="Scrivi qui...">${escapeHtml(msg?.body||"")}</textarea>
    </div>
    <div class="field" style="margin-top:12px">
      <label>Tag (virgola)</label>
      <input id="mTags" value="${escapeHtml((msg?.tags||[]).join(", "))}" placeholder="es. intervento, blocco, meteo" />
    </div>
  `;
  const footer = [
    ...(isEdit ? [{ id:"mDelete", label:"Elimina", kind:"danger" }] : []),
    { id:"mWhatsapp", label:"WhatsApp" },
    { id:"mCancel", label:"Annulla" },
    { id:"mSave", label: isEdit ? "Salva" : "Pubblica", kind:"primary" }
  ];
  openModal({ title: isEdit ? "Messaggio" : "Nuovo messaggio", bodyHTML: body, footerButtons: footer });

  $("#mCancel").onclick = closeModal;
  if(isEdit){
    $("#mDelete").onclick = async ()=>{
      if(!confirm("Eliminare il messaggio?")) return;
      await DB.delete("messages", msg.id);
      toast("Eliminato", msg.title);
      await loadAll();
      closeModal();
      render();
    };
  }
  $("#mSave").onclick = async ()=>{
    const title = $("#mTitle").value.trim();
    const body = $("#mBody").value.trim();
    if(!title || !body){ toast("Campi mancanti", "Titolo e messaggio sono obbligatori."); return; }
    const obj = {
      id: msg?.id || uid("msg"),
      date: msg?.date || new Date().toISOString(),
      channel: $("#mChan").value,
      title,
      body,
      tags: $("#mTags").value.split(",").map(s=>s.trim()).filter(Boolean)
    };
    await DB.put("messages", obj);
    toast(isEdit ? "Salvato" : "Pubblicato", obj.title);
    await loadAll();
    closeModal();
    render();
  };
  $("#mWhatsapp").onclick = ()=>{
    const title = $("#mTitle").value.trim();
    const body = $("#mBody").value.trim();
    if(!title || !body){ toast("Campi mancanti", "Titolo e messaggio sono obbligatori."); return; }
    const channel = $("#mChan").value;
    openWhatsApp(`[${channel}] ${title}\n${body}`);
  };
}

async function openReportModal(){
  const report = buildReportText();
  const body = `
    <div class="split">
      <div>
        <div class="mini" style="margin-bottom:10px">Anteprima report (copiabile / condivisibile)</div>
        <textarea id="rText" style="width:100%; min-height:320px">${escapeHtml(report)}</textarea>
      </div>
      <div>
        <div style="font-weight:700; margin-bottom:8px">Azioni</div>
        <div class="row">
          <button class="btn" id="rCopy">Copia</button>
          <button class="btn primary" id="rShare">Condividi</button>
          <button class="btn" id="rWhatsapp">WhatsApp</button>
          <button class="btn" id="rCSV">CSV ispezioni</button>
        </div>
        <hr class="sep"/>
        <div class="mini">
          Suggerimento: usa WhatsApp o CSV per condividere il report.
        </div>
      </div>
    </div>
  `;
  openModal({
    title: "Report operativo",
    bodyHTML: body,
    footerButtons: [{ id:"rClose", label:"Chiudi" }]
  });

  $("#rClose").onclick = closeModal;
  $("#rCopy").onclick = async ()=>{
    try{
      await navigator.clipboard.writeText($("#rText").value);
      toast("Copiato", "Report copiato in clipboard.");
    }catch(e){
      toast("Errore", "Clipboard non disponibile. Seleziona e copia manualmente.");
    }
  };
  $("#rShare").onclick = async ()=>{
    const text = $("#rText").value;
    if(navigator.share){
      try{
        await navigator.share({ title:"Report OliveFly Sentinel", text });
        toast("Condiviso", "Report inviato.");
      }catch(e){ /* cancelled */ }
    }else{
      toast("Web Share non disponibile", "Copia e incolla su WhatsApp/Email.");
    }
  };
  $("#rWhatsapp").onclick = ()=>{
    openWhatsApp($("#rText").value);
  };
  $("#rCSV").onclick = ()=>{
    const rows = state.inspections.map(i=>{
      const t = state.traps.find(x=>x.id===i.trapId);
      return {
        date: i.date,
        trap: t?.name || "",
        adults: i.adults,
        females: i.females,
        larvae: i.larvae,
        temperature: i.temperature ?? "",
        humidity: i.humidity ?? "",
        wind: i.wind ?? "",
        notes: i.notes ?? ""
      };
    });
    downloadText("inspections.csv", toCSV(rows), "text/csv");
  };
}

function buildReportText(){
  const now = new Date();
  const last7 = state.inspections.filter(i => i.date >= daysAgoISO(6));
  const byTrap = {};
  for(const i of last7){
    byTrap[i.trapId] = byTrap[i.trapId] || { adults:0, larvae:0, n:0 };
    byTrap[i.trapId].adults += i.adults;
    byTrap[i.trapId].larvae += i.larvae;
    byTrap[i.trapId].n += 1;
  }
  const lines = [];
  lines.push(`OLIVEFLY SENTINEL - Report operativo`);
  lines.push(`Data: ${now.toLocaleString("it-IT")}`);
  lines.push(`Periodo: ultimi 7 giorni (da ${formatDate(daysAgoISO(6))} a ${formatDate(todayISO())})`);
  lines.push("");
  lines.push(`Trappole: ${state.traps.length} | Ispezioni periodo: ${last7.length}`);
  const avg = last7.length ? (last7.reduce((s,i)=>s+i.adults,0)/last7.length) : 0;
  const larvaeHits = last7.filter(i=>i.larvae>0).length;
  lines.push(`Media adulti per ispezione: ${avg.toFixed(1)} | Rilevazioni larve: ${larvaeHits}`);
  lines.push("");
  lines.push(`DETTAGLIO PER TRAPPOLA`);
  for(const t of state.traps){
    const d = byTrap[t.id];
    const score = computeRiskForTrap(t.id);
    const r = riskLabel(score);
    if(!d) continue;
    const avgA = d.n ? (d.adults/d.n).toFixed(1) : "0.0";
    lines.push(`- ${t.name} (${t.code||"-"}) — Rischio ${r.label} (${score})`);
    lines.push(`  Ispezioni: ${d.n} | Somma adulti: ${d.adults} | Media adulti: ${avgA} | Somma larve: ${d.larvae}`);
  }
  lines.push("");
  lines.push("NOTE OPERATIVE (suggerite)");
  const suggestions = suggestActions();
  for(const s of suggestions) lines.push(`- ${s}`);
  lines.push("");
  lines.push("Generato con OliveFly Sentinel.");
  return lines.join("\n");
}

function buildQuickUpdateText(){
  const now = new Date();
  const last7 = state.inspections.filter(i => i.date >= daysAgoISO(6));
  const avg = last7.length ? (last7.reduce((s,i)=>s+i.adults,0)/last7.length) : 0;
  const larvaeHits = last7.filter(i=>i.larvae>0).length;
  const top = state.traps
    .map(t=>({ t, score: computeRiskForTrap(t.id) }))
    .sort((a,b)=>b.score-a.score)
    .slice(0,3)
    .filter(x=>x.score>=45);

  const lines = [];
  lines.push(`Aggiornamento rapido - ${DEFAULT_SITE.name}`);
  lines.push(`Data: ${now.toLocaleString("it-IT")}`);
  lines.push(`Trappole: ${state.traps.length} | Ispezioni 7 gg: ${last7.length}`);
  lines.push(`Media adulti/ispezione: ${avg.toFixed(1)} | Larve: ${larvaeHits}`);
  if(top.length){
    lines.push(`Rischio alto: ${top.map(x=>x.t.name).join(", ")}`);
  }else{
    lines.push("Rischio sotto controllo.");
  }
  return lines.join("\n");
}

function suggestActions(){
  const sug = [];
  // Identify top risk traps
  const ranked = state.traps.map(t=>({t, score: computeRiskForTrap(t.id)})).sort((a,b)=>b.score-a.score);
  const top = ranked.slice(0,3).filter(x=>x.score>=45);
  if(top.length){
    sug.push(`Verificare le trappole ad alto rischio: ${top.map(x=>x.t.name).join(", ")} (aumentare frequenza controlli).`);
  }else{
    sug.push("Trend complessivamente sotto controllo: mantenere cadenza ispezioni e sostituzione esche.");
  }
  const larvae = state.inspections.filter(i=>i.date>=daysAgoISO(6) && i.larvae>0);
  if(larvae.length){
    sug.push("Presenza larve: valutare intervento mirato e verifica integrità frutti nelle aree interessate.");
  }
  const high = state.inspections.filter(i=>i.date>=daysAgoISO(6) && i.adults>=5);
  if(high.length){
    sug.push("Picchi di adulti: controllare attrattivo, posizionamento e possibile incremento pressione (meteo/umidità).");
  }
  sug.push("Se disponibile: integrare meteo giornaliero e fenologia per un modello rischio più robusto.");
  return sug;
}

function renderSuggestions(){
  const html = `<ul class="mini">${suggestActions().map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
  const box = $("#suggestBox");
  if(box) box.innerHTML = html;
}

// ---------- Data import/export ----------
async function exportData(all=false){
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    traps: state.traps,
    inspections: state.inspections,
    alerts: state.alerts,
    messages: state.messages,
    settings: state.settings
  };
  if(all){
    payload.media = state.media;
    payload.outbox = state.outbox;
  }
  const name = all ? "olivefly_backup.json" : "olivefly_data.json";
  downloadText(name, JSON.stringify(payload, null, 2), "application/json");
  toast("Export", "File JSON generato.");
}

async function importData(all=false){
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async ()=>{
    const file = input.files?.[0];
    if(!file) return;
    try{
      const text = await file.text();
      const j = JSON.parse(text);

      if(all){
        if(!confirm("Import completo: sovrascrive i dati locali. Continuare?")) return;
        await DB.clear("traps");
        await DB.clear("inspections");
        await DB.clear("alerts");
        await DB.clear("messages");
        await DB.clear("media");
        await DB.clear("outbox");
      }

      for(const t of (j.traps||[])) await DB.put("traps", t);
      for(const i of (j.inspections||[])) await DB.put("inspections", i);
      for(const a of (j.alerts||[])) await DB.put("alerts", a);
      for(const m of (j.messages||[])) await DB.put("messages", m);
      for(const m of (j.media||[])) await DB.put("media", m);
      for(const o of (j.outbox||[])) await DB.put("outbox", o);
      if(j.settings) { state.settings = { ...state.settings, ...j.settings }; await DB.setSetting("app_settings", state.settings); }

      toast("Import completato", "Dati caricati.");
      await loadAll();
      render();
    }catch(e){
      toast("Import fallito", "JSON non valido.");
    }
  };
  input.click();
}

async function resetData(){
  if(!confirm("Ripristinare i dati iniziali di Bari Loseto?")) return;
  await DB.clear("traps");
  await DB.clear("inspections");
  await DB.clear("alerts");
  await DB.clear("messages");
  await DB.clear("media");
  await DB.clear("outbox");
  await DB.setSetting("app_settings", null);
  state.map = { obj:null, layer:null, markers:[] };
  await loadAll();
  render();
  toast("Ripristino", "Dati iniziali ripristinati.");
}

// ---------- Alerts evaluation ----------
async function evaluateAlertsOnInspection(insp){
  const hits = [];
  for(const a of state.alerts.filter(x=>x.active)){
    if(a.metric==="adults" && insp.adults >= Number(a.threshold)) hits.push(a);
    if(a.metric==="larvae" && insp.larvae >= Number(a.threshold)) hits.push(a);
  }
  if(!hits.length) return;

  const t = state.traps.find(x=>x.id===insp.trapId);
  const title = "OliveFly Sentinel — Alert";
  const body = `${t? t.name : "Trappola"} • ${formatDate(insp.date)} • ${hits.map(h=>h.name).join(", ")}`;
  toast("Alert", body);
  pushNotification(title, body);

  // Log message
  await DB.put("messages", {
    id: uid("msg"),
    date: new Date().toISOString(),
    channel: "Team",
    title: "Alert automatico",
    body: body + "\n" + (hits.map(h=>`- ${h.note||h.name}`).join("\n")),
    tags: ["alert","auto"]
  });
  state.messages = await DB.getAll("messages");

  if(state.settings.enableWhatsappAlerts){
    const waBody = [
      body,
      hits.map(h=>`- ${h.note||h.name}`).join("\n"),
      `Adulti: ${insp.adults} | Femmine: ${insp.females} | Larve: ${insp.larvae}`
    ].filter(Boolean).join("\n");
    await enqueueWhatsappNotification({
      title: "Alert automatico",
      body: waBody,
      context: { type: "alert", inspectionId: insp.id, trapId: insp.trapId, alertIds: hits.map(h=>h.id) }
    });
    toast("WhatsApp in coda", "Notifica pronta per invio.");
  }
}

async function evaluateNearbyAlerts(){
  if(!state.settings.enableNearbyAlert) return;
  const nearRule = state.alerts.find(a=>a.active && a.metric==="nearby");
  if(!nearRule) return;
  const pos = await requestLocation({silent:true});
  if(!pos) return;
  const nearby = computeNearbyTraps();
  if(!nearby.length) return;

  const top = nearby[0];
  const title = "Trappola vicina";
  const body = `${top.name} a ~${Math.round(top.dist)}m. Vuoi registrare un'ispezione?`;
  toast(title, body);
  pushNotification("OliveFly Sentinel — " + title, body);

  if(state.settings.enableWhatsappNearby){
    await enqueueWhatsappNotification({
      title,
      body,
      context: { type: "nearby", trapId: top.id, distance: Math.round(top.dist) }
    });
    toast("WhatsApp in coda", "Notifica vicinanza aggiunta.");
  }
}

// ---------- Share log ----------
function buildLogText(){
  const last = [...state.messages].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10);
  return last.map(m=>`- [${new Date(m.date).toLocaleString("it-IT")}] ${m.channel} - ${m.title}\n${m.body}`).join("\n\n");
}

async function shareLog(){
  const text = buildLogText();
  if(navigator.share){
    try{ await navigator.share({ title:"OliveFly Sentinel - Log", text }); toast("Condiviso", "Log inviato."); }catch(e){}
  }else{
    try{ await navigator.clipboard.writeText(text); toast("Copiato", "Log copiato in clipboard."); }catch(e){
      toast("Non supportato", "Copia manuale dalla schermata.");
    }
  }
}

function shareLogWhatsApp(){
  const text = buildLogText();
  openWhatsApp(text);
}

// ---------- Charts ----------
function destroyChart(ch){
  try{ if(ch) ch.destroy(); }catch(e){}
}
function drawCharts(){
  // Weekly sums last 28 days
  const labels = [];
  const values = [];
  for(let w=3; w>=0; w--){
    const start = new Date(); start.setDate(start.getDate() - (w*7+6));
    const end = new Date(); end.setDate(end.getDate() - (w*7));
    const sIso = start.toISOString().slice(0,10);
    const eIso = end.toISOString().slice(0,10);
    const bucket = state.inspections.filter(i=>i.date>=sIso && i.date<=eIso);
    const sumAdults = bucket.reduce((s,i)=>s+i.adults,0);
    labels.push(`${formatDate(sIso)} → ${formatDate(eIso)}`);
    values.push(sumAdults);
  }

  const ctxW = $("#chWeekly");
  if(ctxW){
    destroyChart(state.charts.weekly);
    state.charts.weekly = new Chart(ctxW, {
      type: "line",
      data: { labels, datasets: [{ label: "Adulti (somma)", data: values, tension: 0.25 }] },
      options: { responsive:true, plugins:{ legend:{ display:true } }, scales:{ y:{ beginAtZero:true } } }
    });
  }

  // By trap last 14 days
  const fromIso = daysAgoISO(13);
  const insps = state.inspections.filter(i=>i.date>=fromIso);
  const sums = {};
  for(const i of insps){
    sums[i.trapId] = (sums[i.trapId]||0) + i.adults;
  }
  const tLabels = state.traps.map(t=>t.name);
  const tValues = state.traps.map(t=>sums[t.id]||0);
  const ctxT = $("#chByTrap");
  if(ctxT){
    destroyChart(state.charts.byTrap);
    state.charts.byTrap = new Chart(ctxT, {
      type: "bar",
      data: { labels: tLabels, datasets: [{ label: "Adulti (ultimi 14 gg)", data: tValues }] },
      options: { responsive:true, plugins:{ legend:{ display:true } }, scales:{ y:{ beginAtZero:true } } }
    });
  }

  // Risk radar-ish: use bar
  const rLabels = state.traps.map(t=>t.name);
  const rValues = state.traps.map(t=>computeRiskForTrap(t.id));
  const ctxR = $("#chRisk");
  if(ctxR){
    destroyChart(state.charts.risk);
    state.charts.risk = new Chart(ctxR, {
      type: "bar",
      data: { labels: rLabels, datasets: [{ label: "Risk score (0-100)", data: rValues }] },
      options: { responsive:true, plugins:{ legend:{ display:true } }, scales:{ y:{ beginAtZero:true, max:100 } } }
    });
  }

  // risk table
  const box = $("#riskTable");
  if(box){
    const rows = state.traps
      .map(t=>({ t, score: computeRiskForTrap(t.id) }))
      .sort((a,b)=>b.score-a.score)
      .slice(0,8);
    box.innerHTML = `
      <table class="table">
        <thead><tr><th>Trappola</th><th>Rischio</th></tr></thead>
        <tbody>
          ${rows.map(x=>{
            const r = riskLabel(x.score);
            return `<tr><td>${escapeHtml(x.t.name)}</td><td><span class="pill ${r.cls}">${r.label} • ${x.score}</span></td></tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
  }
  renderSuggestions();
}

// ---------- File helpers ----------
function downloadText(filename, text, mime){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = ()=> reject(r.error);
    r.readAsDataURL(file);
  });
}

// ---------- Global controls ----------
$("#search").addEventListener("input", (e)=>{
  state.q = e.target.value;
  render();
});

$("#btnHamburger").onclick = ()=>{
  $("#sidebar").classList.toggle("open");
  setTimeout(()=>{ try{ state.map.obj && state.map.obj.invalidateSize(); }catch(e){} }, 300);
};

$("#btnLocate").onclick = async ()=>{
  await requestLocation();
  if(state.route==="map") drawMapMarkers();
  render();
};

$("#btnQuickInspect").onclick = ()=>{
  openInspectionModal();
};

const nav = $("#nav");
if(nav){
  nav.addEventListener("click", (e)=>{
    const link = e.target.closest("a");
    if(!link) return;
    if(window.matchMedia("(max-width: 980px)").matches){
      const sidebar = $("#sidebar");
      if(sidebar) sidebar.classList.remove("open");
    }
  });
}

window.addEventListener("hashchange", ()=>{
  render();
  if(window.matchMedia("(max-width: 980px)").matches){
    const sidebar = $("#sidebar");
    if(sidebar) sidebar.classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

// Mobile FAB + responsive map handling (adds FAB/menu dynamically)
(function ensureMobileUI(){
  if(typeof document === 'undefined') return;
  const existingFab = document.getElementById('fabAction');
  const existingMenu = document.getElementById('fabMenu');
  if(!existingFab){
    const fab = document.createElement('button');
    fab.id = 'fabAction'; fab.className = 'fab'; fab.setAttribute('aria-label','Azioni rapide'); fab.innerText = 'Azioni';
    const menu = document.createElement('div'); menu.id = 'fabMenu'; menu.className = 'fab-menu'; menu.setAttribute('aria-hidden','true');
    const b1 = document.createElement('button'); b1.id='fabAddTrap'; b1.className='btn'; b1.innerText='Aggiungi trappola';
    const b2 = document.createElement('button'); b2.id='fabQuickInspectMenu'; b2.className='btn primary'; b2.innerText='Ispezione rapida';
    menu.appendChild(b1); menu.appendChild(b2);
    document.body.appendChild(menu); document.body.appendChild(fab);

    fab.addEventListener('click', (e)=>{
      e.stopPropagation(); menu.classList.toggle('open');
    });
    b1.addEventListener('click', ()=>{ openTrapModal(); menu.classList.remove('open'); });
    b2.addEventListener('click', ()=>{ openInspectionModal(); menu.classList.remove('open'); });
    document.addEventListener('click', (e)=>{ if(!menu.contains(e.target) && e.target !== fab) menu.classList.remove('open'); });

    const mq = window.matchMedia('(max-width:980px)');
    const updateFab = ()=>{ if(mq.matches){ fab.style.display='flex'; } else { fab.style.display='none'; menu.classList.remove('open'); } };
    if(mq.addEventListener) mq.addEventListener('change', updateFab); else mq.addListener(updateFab);
    updateFab();
  }
  if(existingFab && existingMenu){
    const fab = existingFab;
    const menu = existingMenu;
    const b1 = document.getElementById('fabAddTrap');
    const b2 = document.getElementById('fabQuickInspectMenu');
    if(fab && menu && b1 && b2){
      fab.addEventListener('click', (e)=>{
        e.stopPropagation(); menu.classList.toggle('open');
      });
      b1.addEventListener('click', ()=>{ openTrapModal(); menu.classList.remove('open'); });
      b2.addEventListener('click', ()=>{ openInspectionModal(); menu.classList.remove('open'); });
      document.addEventListener('click', (e)=>{ if(!menu.contains(e.target) && e.target !== fab) menu.classList.remove('open'); });

      const mq = window.matchMedia('(max-width:980px)');
      const updateFab = ()=>{ if(mq.matches){ fab.style.display='flex'; } else { fab.style.display='none'; menu.classList.remove('open'); } };
      if(mq.addEventListener) mq.addEventListener('change', updateFab); else mq.addListener(updateFab);
      updateFab();
    }
  }

  window.addEventListener('resize', ()=>{ try{ state.map.obj && state.map.obj.invalidateSize(); }catch(e){} });
  window.addEventListener('orientationchange', ()=>{ try{ state.map.obj && state.map.obj.invalidateSize(); }catch(e){} });
})();

// Register service worker
if("serviceWorker" in navigator){
  window.addEventListener("load", async ()=>{
    try{
      await navigator.serviceWorker.register("./sw.js");
    }catch(e){
      // ignore
    }
  });
}

// Init
(async function init(){
  await loadAll();
  render();

  // Soft prompts
  
  // Evaluate nearby alert on launch
  setTimeout(()=> evaluateNearbyAlerts(), 900);
})();
