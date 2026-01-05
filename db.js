/**
 * OliveFly Sentinel - IndexedDB helper
 * Stores: traps, inspections, alerts, messages, settings
 */
const DB_NAME = "olivefly_sentinel_db";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = req.transaction;

      const traps = db.objectStoreNames.contains("traps")
        ? tx.objectStore("traps")
        : db.createObjectStore("traps", { keyPath: "id" });
      if(!traps.indexNames.contains("by_name")){
        traps.createIndex("by_name", "name", { unique: false });
      }

      const inspections = db.objectStoreNames.contains("inspections")
        ? tx.objectStore("inspections")
        : db.createObjectStore("inspections", { keyPath: "id" });
      if(!inspections.indexNames.contains("by_trapId")){
        inspections.createIndex("by_trapId", "trapId", { unique: false });
      }
      if(!inspections.indexNames.contains("by_date")){
        inspections.createIndex("by_date", "date", { unique: false });
      }

      const alerts = db.objectStoreNames.contains("alerts")
        ? tx.objectStore("alerts")
        : db.createObjectStore("alerts", { keyPath: "id" });
      if(!alerts.indexNames.contains("by_active")){
        alerts.createIndex("by_active", "active", { unique: false });
      }

      const messages = db.objectStoreNames.contains("messages")
        ? tx.objectStore("messages")
        : db.createObjectStore("messages", { keyPath: "id" });
      if(!messages.indexNames.contains("by_date")){
        messages.createIndex("by_date", "date", { unique: false });
      }

      if(!db.objectStoreNames.contains("settings")){
        db.createObjectStore("settings", { keyPath: "key" });
      }

      if(!db.objectStoreNames.contains("media")){
        const media = db.createObjectStore("media", { keyPath: "id" });
        media.createIndex("by_inspectionId", "inspectionId", { unique: false });
        media.createIndex("by_trapId", "trapId", { unique: false });
        media.createIndex("by_createdAt", "createdAt", { unique: false });
      }

      if(!db.objectStoreNames.contains("outbox")){
        const outbox = db.createObjectStore("outbox", { keyPath: "id" });
        outbox.createIndex("by_status", "status", { unique: false });
        outbox.createIndex("by_createdAt", "createdAt", { unique: false });
        outbox.createIndex("by_channel", "channel", { unique: false });
      }

      if(e.oldVersion < 2){
        const mediaStore = tx.objectStore("media");
        const inspStore = tx.objectStore("inspections");
        inspStore.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if(!cursor) return;
          const insp = cursor.value;
          if(insp && insp.photoDataUrl && !insp.mediaIds){
            const mediaId = `media_${crypto.randomUUID()}`;
            mediaStore.put({
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
            cursor.update(insp);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export const DB = {
  async get(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, "readonly");
      const s = t.objectStore(store);
      const r = s.get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async getAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, "readonly");
      const s = t.objectStore(store);
      const r = s.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  },
  async put(store, value) {
    return tx(store, "readwrite", (s) => s.put(value));
  },
  async delete(store, key) {
    return tx(store, "readwrite", (s) => s.delete(key));
  },
  async clear(store) {
    return tx(store, "readwrite", (s) => s.clear());
  },
  async indexGetAll(store, indexName, query) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, "readonly");
      const s = t.objectStore(store);
      const idx = s.index(indexName);
      const r = idx.getAll(query);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  },
  async setSetting(key, value) {
    return this.put("settings", { key, value });
  },
  async getSetting(key, fallback=null) {
    const v = await this.get("settings", key);
    return v ? v.value : fallback;
  }
};

export function uid(prefix="id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
