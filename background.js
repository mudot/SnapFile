/**
 * SnapFile v0.6 — background service worker
 * Local downloads + clipboard + Google Drive adapter sketch
 */

import { driveAdapter } from "./drive-adapter.js";

const DB_NAME = "snapfile-v6";
const DB_VERSION = 1;
const STORE_META = "records";
const STORE_CONTENT = "contents";

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 400 * 1024 * 1024;
const MAX_RECORDS = 100;
const AUTO_RESOLVE_RECENT = 25;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_CONTENT)) db.createObjectStore(STORE_CONTENT, { keyPath: "id" });
    };
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(id);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

async function idbDelete(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function basename(path) {
  if (!path) return "file";
  return path.split(/[/\\]/).pop() || path;
}

function pathToFileUrl(path) {
  if (!path) return null;
  if (path.startsWith("file:")) return path;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return "file:///" + path.replace(/\\/g, "/");
  if (path.startsWith("/")) return "file://" + path;
  return null;
}

function guessMime(filename, mime) {
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain",
    zip: "application/zip", mp4: "video/mp4"
  };
  return map[ext] || mime || "application/octet-stream";
}

function categoryOf(mime, name) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  if (m.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp)$/.test(n)) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.includes("pdf") || n.endsWith(".pdf")) return "pdf";
  if (/zip|rar|7z/.test(m) || /\.(zip|rar|7z)$/.test(n)) return "archive";
  if (/text|json|csv/.test(m)) return "text";
  if (/officedocument|msword/.test(m)) return "document";
  return "other";
}

async function sha256(buffer) {
  try {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function extFromMime(mime) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] || "png";
}

async function storeContent(id, buffer, meta) {
  const hash = await sha256(buffer);
  const all = await idbGetAll(STORE_CONTENT);
  if (hash) {
    const dup = all.find((c) => c.hash === hash);
    if (dup) {
      const existingMeta = await idbGet(STORE_META, dup.id);
      if (existingMeta) {
        existingMeta.lastUsedAt = Date.now();
        existingMeta.usageCount = (existingMeta.usageCount || 0) + 1;
        await idbPut(STORE_META, existingMeta);
      }
      return { id: dup.id, deduped: true, hash, size: dup.size };
    }
  }
  let total = all.reduce((s, c) => s + (c.size || 0), 0) + buffer.byteLength;
  if (total > MAX_LIBRARY_BYTES) {
    const sorted = all.sort((a, b) => (a.storedAt || 0) - (b.storedAt || 0));
    for (const old of sorted) {
      if (total <= MAX_LIBRARY_BYTES * 0.8) break;
      await idbDelete(STORE_CONTENT, old.id);
      total -= old.size || 0;
    }
  }
  await idbPut(STORE_CONTENT, {
    id,
    blob: buffer,
    size: buffer.byteLength,
    mime: meta.mimeType,
    name: meta.filename,
    hash,
    storedAt: Date.now(),
    lastAccessedAt: Date.now()
  });
  return { id, deduped: false, hash, size: buffer.byteLength };
}

async function getCachedContent(id) {
  return idbGet(STORE_CONTENT, id);
}

function itemToRecord(item) {
  const name = basename(item.filename || item.url || "file");
  const mime = guessMime(name, item.mime);
  return {
    id: "dl-" + item.id,
    downloadId: item.id,
    filename: name,
    filePath: item.filename || null,
    url: item.url || null,
    finalUrl: item.finalUrl || item.url || null,
    mimeType: mime,
    fileSize: item.fileSize || item.totalBytes || 0,
    startTime: item.startTime ? Date.parse(item.startTime) : Date.now(),
    endTime: item.endTime ? Date.parse(item.endTime) : null,
    state: item.state || "unknown",
    exists: item.exists !== false,
    category: categoryOf(mime, name),
    source: "download",
    contentState: "METADATA_ONLY",
    resolveLog: [],
    createdAt: Date.now(),
    lastUsedAt: null,
    usageCount: 0
  };
}

const resolveLocks = new Set();

async function resolveContent(rec) {
  if (resolveLocks.has(rec.id)) return rec;
  resolveLocks.add(rec.id);
  const log = [];
  const push = (strategy, status, detail) => {
    log.push({ strategy, status, detail, t: Date.now() });
  };
  try {
    const cached = await getCachedContent(rec.id);
    if (cached?.blob) {
      push("cache", "SUCCESS", String(cached.size));
      rec.contentState = "AVAILABLE";
      rec.resolveLog = log;
      await idbPut(STORE_META, rec);
      return rec;
    }
    if (rec.fileSize && rec.fileSize > MAX_FILE_BYTES) {
      push("size", "SKIP", "too large");
      rec.contentState = "METADATA_ONLY";
      rec.resolveLog = log;
      await idbPut(STORE_META, rec);
      return rec;
    }
    rec.contentState = "RESOLVING";
    await idbPut(STORE_META, rec);

    const fileUrl = pathToFileUrl(rec.filePath);
    if (fileUrl) {
      try {
        const resp = await fetch(fileUrl);
        if (resp.ok) {
          const buffer = await resp.arrayBuffer();
          if (buffer.byteLength > 0) {
            await storeContent(rec.id, buffer, rec);
            push("file://", "SUCCESS", String(buffer.byteLength));
            rec.contentState = "AVAILABLE";
            rec.resolveLog = log;
            await idbPut(STORE_META, rec);
            return rec;
          }
        }
        push("file://", "FAILED", "http/empty");
      } catch (e) {
        push("file://", "FAILED", e.message);
      }
    } else push("file://", "SKIP", "no path");

    const url = rec.finalUrl || rec.url;
    if (url?.startsWith("http")) {
      try {
        const resp = await fetch(url, { credentials: "include", redirect: "follow", cache: "force-cache" });
        if (resp.ok) {
          const buffer = await resp.arrayBuffer();
          if (buffer.byteLength > 0 && buffer.byteLength <= MAX_FILE_BYTES) {
            await storeContent(rec.id, buffer, rec);
            push("url-fetch", "SUCCESS", String(buffer.byteLength));
            rec.contentState = "AVAILABLE";
            rec.resolveLog = log;
            await idbPut(STORE_META, rec);
            return rec;
          }
        }
        push("url-fetch", "FAILED", "http/size");
      } catch (e) {
        push("url-fetch", "FAILED", e.message);
      }
    } else push("url-fetch", "SKIP", "no http");

    rec.contentState = "METADATA_ONLY";
    rec.resolveLog = log;
    await idbPut(STORE_META, rec);
    return rec;
  } finally {
    resolveLocks.delete(rec.id);
  }
}

async function upsertFromItem(item) {
  const rec = itemToRecord(item);
  const prev = await idbGet(STORE_META, rec.id);
  if (prev) {
    rec.usageCount = prev.usageCount || 0;
    rec.lastUsedAt = prev.lastUsedAt;
    rec.createdAt = prev.createdAt || rec.createdAt;
    if (await getCachedContent(rec.id)) {
      rec.contentState = "AVAILABLE";
      rec.resolveLog = prev.resolveLog || [];
    }
  }
  await idbPut(STORE_META, rec);
  return rec;
}

async function syncExistingDownloads() {
  let items = [];
  try {
    items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 80, state: "complete" });
  } catch {
    return { count: 0, resolved: 0 };
  }
  const records = [];
  for (const item of items) {
    if (!item.filename && !item.url) continue;
    records.push(await upsertFromItem(item));
  }
  const toResolve = records
    .filter((r) => r.contentState !== "AVAILABLE")
    .sort((a, b) => (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0))
    .slice(0, AUTO_RESOLVE_RECENT);
  let resolved = 0;
  for (const rec of toResolve) {
    if ((await resolveContent(rec)).contentState === "AVAILABLE") resolved++;
  }
  return { count: records.length, resolved };
}

chrome.downloads.onCreated.addListener((item) => upsertFromItem(item));
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.id) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;
  const rec = await upsertFromItem(item);
  if (item.state === "complete") await resolveContent(rec);
});

async function ingestClipboardImage({ mime, arrayBuffer }) {
  const buffer = new Uint8Array(arrayBuffer).buffer;
  if (!buffer.byteLength) return { ok: false, error: "empty" };
  if (buffer.byteLength > MAX_FILE_BYTES) return { ok: false, error: "too large" };
  const mimeType = mime || "image/png";
  if (!IMAGE_MIMES.includes(mimeType) && !mimeType.startsWith("image/")) {
    return { ok: false, error: "not an image" };
  }
  const hash = await sha256(buffer);
  if (hash) {
    const allContent = await idbGetAll(STORE_CONTENT);
    const dup = allContent.find((c) => c.hash === hash);
    if (dup) {
      const meta = await idbGet(STORE_META, dup.id);
      if (meta) {
        meta.lastUsedAt = Date.now();
        meta.usageCount = (meta.usageCount || 0) + 1;
        await idbPut(STORE_META, meta);
      }
      return { ok: true, id: dup.id, deduped: true, filename: meta?.filename || dup.name };
    }
  }
  const id = "clip-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const filename = `clipboard-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${extFromMime(mimeType)}`;
  const rec = {
    id,
    filename,
    mimeType,
    fileSize: buffer.byteLength,
    startTime: Date.now(),
    endTime: Date.now(),
    category: "image",
    source: "clipboard",
    contentState: "AVAILABLE",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    usageCount: 1
  };
  await storeContent(id, buffer, rec);
  await idbPut(STORE_META, rec);
  return { ok: true, id, deduped: false, filename, size: buffer.byteLength };
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncExistingDownloads();
  const { helpSeen } = await chrome.storage.local.get("helpSeen");
  if (!helpSeen) await chrome.storage.local.set({ helpSeen: false });
});
chrome.runtime.onStartup.addListener(() => syncExistingDownloads());
syncExistingDownloads();

function bufferToArray(buf) {
  if (buf instanceof ArrayBuffer) return Array.from(new Uint8Array(buf));
  if (buf?.arrayBuffer) return null; // async path
  return Array.from(new Uint8Array(buf));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "CLIPBOARD_IMAGE") {
        sendResponse(await ingestClipboardImage(msg));
        return;
      }

      if (msg.type === "GET_LIBRARY") {
        const all = await idbGetAll(STORE_META);
        all.sort((a, b) => {
          const ta = a.lastUsedAt || a.endTime || a.startTime || 0;
          const tb = b.lastUsedAt || b.endTime || b.startTime || 0;
          return tb - ta;
        });
        const available = [];
        for (const r of all.slice(0, MAX_RECORDS)) {
          const content = await getCachedContent(r.id);
          if (content) {
            available.push({
              ...r,
              contentState: "AVAILABLE",
              hasContent: true,
              // small preview flag for images
              isImage: (r.mimeType || "").startsWith("image/") || r.category === "image"
            });
          }
        }
        sendResponse({ ok: true, available });
        return;
      }

      if (msg.type === "GET_CONTENT") {
        let content = await getCachedContent(msg.recordId);
        if (!content?.blob) {
          const rec = await idbGet(STORE_META, msg.recordId);
          if (rec?.source === "download") {
            await resolveContent(rec);
            content = await getCachedContent(msg.recordId);
          }
        }
        if (!content?.blob) {
          sendResponse({ ok: false, error: "content not available" });
          return;
        }
        let buf = content.blob;
        if (!(buf instanceof ArrayBuffer) && buf?.arrayBuffer) buf = await buf.arrayBuffer();
        content.lastAccessedAt = Date.now();
        await idbPut(STORE_CONTENT, content);
        sendResponse({
          ok: true,
          name: content.name,
          mime: content.mime,
          size: content.size,
          arrayBuffer: Array.from(new Uint8Array(buf))
        });
        return;
      }

      if (msg.type === "GET_PREVIEW_BYTES") {
        // for thumbnail in UI — same as GET_CONTENT but images only preference
        const content = await getCachedContent(msg.recordId);
        if (!content?.blob) {
          sendResponse({ ok: false });
          return;
        }
        let buf = content.blob;
        if (!(buf instanceof ArrayBuffer) && buf?.arrayBuffer) buf = await buf.arrayBuffer();
        sendResponse({
          ok: true,
          mime: content.mime,
          arrayBuffer: Array.from(new Uint8Array(buf))
        });
        return;
      }

      if (msg.type === "FORCE_SYNC") {
        sendResponse({ ok: true, ...(await syncExistingDownloads()) });
        return;
      }

      if (msg.type === "MARK_USED") {
        const rec = await idbGet(STORE_META, msg.recordId);
        if (rec) {
          rec.lastUsedAt = Date.now();
          rec.usageCount = (rec.usageCount || 0) + 1;
          await idbPut(STORE_META, rec);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "GET_HELP_SEEN") {
        const { helpSeen } = await chrome.storage.local.get("helpSeen");
        sendResponse({ ok: true, helpSeen: !!helpSeen });
        return;
      }

      if (msg.type === "SET_HELP_SEEN") {
        await chrome.storage.local.set({ helpSeen: true });
        sendResponse({ ok: true });
        return;
      }

      // ---- Google Drive adapter ----
      if (msg.type === "DRIVE_STATUS") {
        const st = await driveAdapter.getStatus();
        // Se não há token em memória, tenta silencioso (Chrome pode ter cache)
        if (!st.hasToken && st.configured) {
          const silent = await driveAdapter.ensureAuth({ interactive: false });
          if (silent.ok) st.hasToken = true;
        }
        sendResponse({ ok: true, ...st });
        return;
      }

      if (msg.type === "DRIVE_CONNECT") {
        const auth = await driveAdapter.ensureAuth({ interactive: true });
        sendResponse(auth);
        return;
      }

      if (msg.type === "DRIVE_LIST") {
        sendResponse(await driveAdapter.listRecent({ pageSize: msg.pageSize || 20 }));
        return;
      }

      if (msg.type === "DRIVE_DOWNLOAD") {
        const result = await driveAdapter.downloadFile(msg.driveId);
        if (!result.ok) {
          sendResponse(result);
          return;
        }
        sendResponse({
          ok: true,
          size: result.size,
          arrayBuffer: Array.from(new Uint8Array(result.buffer))
        });
        return;
      }

      if (msg.type === "DRIVE_DISCONNECT") {
        await driveAdapter.revokeAuth();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown" });
    } catch (err) {
      console.error("[SnapFile]", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});

console.log("[SnapFile] v0.6 background ready");
