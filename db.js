/**
 * OliveFly Sentinel - IndexedDB helper
 * Stores: traps, inspections, alerts, messages, settings
 */
const DB_NAME = "olivefly_sentinel_db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      const traps = db.createObjectStore("traps", { keyPath: "id" });
      traps.createIndex("by_name", "name", { unique: false });

      const inspections = db.createObjectStore("inspections", { keyPath: "id" });
      inspections.createIndex("by_trapId", "trapId", { unique: false });
      inspections.createIndex("by_date", "date", { unique: false });

      const alerts = db.createObjectStore("alerts", { keyPath: "id" });
      alerts.createIndex("by_active", "active", { unique: false });

      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("by_date", "date", { unique: false });

      db.createObjectStore("settings", { keyPath: "key" });
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
