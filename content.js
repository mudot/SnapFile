/**
 * SnapFile v0.6 — content script
 * Option 3 UI: list + side preview | brand colors | help | Drive tab sketch
 */
(function () {
  "use strict";
  if (window.__snapFileV6) return;
  window.__snapFileV6 = true;

  const C = {
    bg: "#0B0F1A",
    surface: "#12182A",
    surface2: "#1A2236",
    border: "#243049",
    text: "#F1F5F9",
    muted: "#94A3B8",
    accent: "#6366F1",
    accent2: "#8B5CF6",
    select: "rgba(99,102,241,0.28)",
    yellow: "#F5C542"
  };

  let activeInput = null;
  let overlayHost = null;
  let allowNativeOnce = false;
  let focusedId = null;
  let library = [];
  let tab = "local"; // local | drive
  let driveFiles = [];
  let driveStatus = null;

  function isFileInput(el) {
    return el && el.tagName === "INPUT" && el.type === "file" && !el.webkitdirectory && !el.dataset.snapfileInternal;
  }

  function injectFiles(input, files) {
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    } catch {
      return false;
    }
  }

  function formatSize(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function dayGroup(ts) {
    if (!ts) return "Anteriores";
    const d = new Date(ts);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 86400000;
    if (d.getTime() >= startToday) return "Hoje";
    if (d.getTime() >= startYesterday) return "Ontem";
    return "Anteriores";
  }

  function iconSvg(kind) {
    if (kind === "pdf") return `<span style="width:28px;height:28px;border-radius:6px;background:#3B1F1F;color:#F87171;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">PDF</span>`;
    if (kind === "zip") return `<span style="width:28px;height:28px;border-radius:6px;background:#3B2F1F;color:#FBBF24;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">ZIP</span>`;
    if (kind === "clip") return `<span style="width:28px;height:28px;border-radius:6px;background:#1E293B;color:#A78BFA;display:flex;align-items:center;justify-content:center;font-size:14px">📋</span>`;
    return `<span style="width:28px;height:28px;border-radius:6px;background:#1E293B;color:#94A3B8;display:flex;align-items:center;justify-content:center;font-size:14px">📄</span>`;
  }

  function closeOverlay() {
    if (overlayHost) {
      overlayHost.querySelectorAll("img[data-blob]").forEach((img) => {
        try { URL.revokeObjectURL(img.src); } catch {}
      });
      overlayHost.remove();
    }
    overlayHost = null;
    activeInput = null;
    focusedId = null;
  }

  async function readClipboardImage() {
    try {
      if (!navigator.clipboard?.read) return null;
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const t = item.types.find((x) => x.startsWith("image/"));
        if (!t) continue;
        const blob = await item.getType(t);
        const buffer = await blob.arrayBuffer();
        return { mime: t, arrayBuffer: Array.from(new Uint8Array(buffer)) };
      }
    } catch {}
    return null;
  }

  async function captureClipboard() {
    const clip = await readClipboardImage();
    if (!clip) return;
    await chrome.runtime.sendMessage({ type: "CLIPBOARD_IMAGE", ...clip });
  }

  async function loadLocalLibrary() {
    const res = await chrome.runtime.sendMessage({ type: "GET_LIBRARY" });
    library = res?.available || [];
    return library;
  }

  async function useRecord(id, meta) {
    const res = await chrome.runtime.sendMessage({ type: "GET_CONTENT", recordId: id });
    if (!res?.ok) return false;
    const file = new File([new Uint8Array(res.arrayBuffer)], res.name || meta?.filename || "file", {
      type: res.mime || "application/octet-stream",
      lastModified: Date.now()
    });
    const ok = injectFiles(activeInput, [file]);
    if (ok) {
      chrome.runtime.sendMessage({ type: "MARK_USED", recordId: id });
      setTimeout(closeOverlay, 180);
    }
    return ok;
  }

  async function useDriveFile(f) {
    const res = await chrome.runtime.sendMessage({ type: "DRIVE_DOWNLOAD", driveId: f.driveId });
    if (!res?.ok) {
      alert("Não foi possível baixar do Drive: " + (res?.message || res?.error || ""));
      return false;
    }
    const file = new File([new Uint8Array(res.arrayBuffer)], f.filename, {
      type: f.mimeType || "application/octet-stream",
      lastModified: Date.now()
    });
    const ok = injectFiles(activeInput, [file]);
    if (ok) setTimeout(closeOverlay, 180);
    return ok;
  }

  function logoUrl() {
    return chrome.runtime.getURL("icons/icon48.png");
  }

  function buildHelp(panel) {
    const help = document.createElement("div");
    help.id = "sf-help";
    Object.assign(help.style, {
      position: "absolute", inset: "0", background: "rgba(11,15,26,0.92)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: "2",
      borderRadius: "14px"
    });
    help.innerHTML = `
      <div style="width:min(340px,90%);background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:22px 20px;box-shadow:0 20px 50px rgba(0,0,0,.45)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <img src="${logoUrl()}" width="28" height="28" style="border-radius:8px" alt="" />
          <div style="font-weight:600;font-size:15px;color:${C.text}">Como usar o <span style="background:linear-gradient(90deg,#60A5FA,#A78BFA);-webkit-background-clip:text;color:transparent">SnapFile</span></div>
        </div>
        <ol style="margin:0 0 16px;padding-left:18px;color:${C.muted};font-size:13px;line-height:1.7">
          <li><b style="color:${C.text}">Baixe</b> um arquivo ou <b style="color:${C.text}">copie</b> uma imagem</li>
          <li><b style="color:${C.text}">Clique</b> em qualquer campo de envio no site</li>
          <li><b style="color:${C.text}">Escolha</b> na lista e confira o preview</li>
          <li>O arquivo é <b style="color:${C.text}">anexado automaticamente</b></li>
        </ol>
        <button id="sf-help-ok" style="width:100%;padding:11px;border:0;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px;color:#fff;background:linear-gradient(90deg,#3B82F6,#8B5CF6)">Entendi</button>
      </div>`;
    panel.appendChild(help);
    help.querySelector("#sf-help-ok").onclick = async () => {
      await chrome.runtime.sendMessage({ type: "SET_HELP_SEEN" });
      help.remove();
    };
  }

  async function openOverlay(input) {
    closeOverlay();
    activeInput = input;
    tab = "local";
    captureClipboard().catch(() => {});

    overlayHost = document.createElement("div");
    Object.assign(overlayHost.style, {
      position: "fixed", inset: "0", zIndex: "2147483647",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.55)", fontFamily: "system-ui,-apple-system,Segoe UI,sans-serif"
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      position: "relative",
      width: "min(720px, 96vw)",
      height: "min(480px, 86vh)",
      background: C.bg,
      color: C.text,
      borderRadius: "14px",
      border: `1px solid ${C.border}`,
      boxShadow: "0 25px 60px rgba(0,0,0,0.55)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden"
    });

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid ${C.border}">
        <div style="display:flex;align-items:center;gap:8px">
          <img src="${logoUrl()}" width="24" height="24" style="border-radius:6px" alt="" />
          <span style="font-weight:600;font-size:14px">Snap<span style="background:linear-gradient(90deg,#60A5FA,#A78BFA);-webkit-background-clip:text;color:transparent">File</span></span>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="sf-help-btn" title="Ajuda" style="width:28px;height:28px;border-radius:8px;border:1px solid ${C.border};background:${C.surface};color:${C.muted};cursor:pointer;font-size:13px">?</button>
          <button id="sf-close" style="width:28px;height:28px;border-radius:8px;border:1px solid ${C.border};background:${C.surface};color:${C.muted};cursor:pointer;font-size:14px">✕</button>
        </div>
      </div>
      <div style="display:flex;gap:0;padding:0 14px;border-bottom:1px solid ${C.border}">
        <button class="sf-tab" data-tab="local" style="padding:10px 14px;border:0;background:transparent;color:${C.text};font-size:12px;font-weight:600;cursor:pointer;border-bottom:2px solid ${C.accent}">Local</button>
        <button class="sf-tab" data-tab="drive" style="padding:10px 14px;border:0;background:transparent;color:${C.muted};font-size:12px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent">Drive</button>
      </div>
      <div style="flex:1;display:flex;min-height:0">
        <div id="sf-list" style="width:42%;border-right:1px solid ${C.border};overflow:auto;padding:8px"></div>
        <div id="sf-preview" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;background:${C.surface}">
          <div style="color:${C.muted};font-size:13px">Selecione um arquivo</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-top:1px solid ${C.border}">
        <button id="sf-native" style="background:transparent;border:0;color:${C.muted};font-size:12px;cursor:pointer;padding:4px 0">Escolher no computador…</button>
        <button id="sf-use" style="padding:8px 16px;border:0;border-radius:8px;background:linear-gradient(90deg,#3B82F6,#8B5CF6);color:#fff;font-size:12px;font-weight:600;cursor:pointer;opacity:0.4" disabled>Usar arquivo</button>
      </div>`;

    overlayHost.appendChild(panel);
    document.documentElement.appendChild(overlayHost);

    const listEl = panel.querySelector("#sf-list");
    const previewEl = panel.querySelector("#sf-preview");
    const useBtn = panel.querySelector("#sf-use");

    function setTabs() {
      panel.querySelectorAll(".sf-tab").forEach((b) => {
        const on = b.dataset.tab === tab;
        b.style.color = on ? C.text : C.muted;
        b.style.borderBottomColor = on ? C.accent : "transparent";
        b.style.fontWeight = on ? "600" : "500";
      });
    }

    async function renderPreview(item) {
      previewEl.innerHTML = "";
      if (!item) {
        previewEl.innerHTML = `<div style="color:${C.muted};font-size:13px">Selecione um arquivo</div>`;
        useBtn.disabled = true;
        useBtn.style.opacity = "0.4";
        return;
      }
      useBtn.disabled = false;
      useBtn.style.opacity = "1";

      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:12px;max-width:100%";

      if (item.isImage || (item.mimeType || "").startsWith("image/") || item.source === "clipboard") {
        const img = document.createElement("img");
        img.style.cssText = "max-width:100%;max-height:280px;border-radius:10px;object-fit:contain;background:#0a0e18";
        img.alt = item.filename;
        img.dataset.blob = "1";
        if (item.source === "gdrive" && item.thumbnailLink) {
          img.src = item.thumbnailLink;
        } else if (item.id && !String(item.id).startsWith("gdrive")) {
          const prev = await chrome.runtime.sendMessage({ type: "GET_PREVIEW_BYTES", recordId: item.id });
          if (prev?.ok) {
            const blob = new Blob([new Uint8Array(prev.arrayBuffer)], { type: prev.mime });
            img.src = URL.createObjectURL(blob);
          }
        }
        wrap.appendChild(img);
      } else {
        const box = document.createElement("div");
        box.style.cssText = `width:120px;height:120px;border-radius:16px;background:${C.surface2};display:flex;align-items:center;justify-content:center;font-size:40px`;
        box.textContent = item.category === "pdf" ? "📄" : item.category === "archive" ? "📦" : "📎";
        wrap.appendChild(box);
      }

      const cap = document.createElement("div");
      cap.style.cssText = "text-align:center";
      cap.innerHTML = `<div style="font-size:13px;font-weight:600;color:${C.text};word-break:break-all">${escapeHtml(item.filename)}</div>
        <div style="font-size:12px;color:${C.muted};margin-top:4px">${formatSize(item.fileSize)}${item.source === "clipboard" ? " · clipboard" : item.source === "gdrive" ? " · Drive" : ""}</div>`;
      wrap.appendChild(cap);
      previewEl.appendChild(wrap);
    }

    function renderLocalList() {
      listEl.innerHTML = "";
      if (!library.length) {
        listEl.innerHTML = `<div style="padding:24px 12px;text-align:center;color:${C.muted};font-size:12px;line-height:1.5">
          Nenhum arquivo pronto ainda.<br><br>
          Baixe algo ou copie uma imagem,<br>depois atualize.
          <div style="margin-top:12px"><button id="sf-refresh" style="padding:6px 12px;border-radius:8px;border:1px solid ${C.border};background:${C.surface2};color:${C.text};cursor:pointer;font-size:12px">Atualizar</button></div>
        </div>`;
        listEl.querySelector("#sf-refresh")?.addEventListener("click", async () => {
          await captureClipboard();
          await chrome.runtime.sendMessage({ type: "FORCE_SYNC" });
          await loadLocalLibrary();
          renderLocalList();
          if (library[0]) {
            focusedId = library[0].id;
            renderPreview(library[0]);
          }
        });
        renderPreview(null);
        return;
      }

      const groups = {};
      for (const item of library) {
        const g = dayGroup(item.lastUsedAt || item.endTime || item.startTime || item.createdAt);
        (groups[g] = groups[g] || []).push(item);
      }
      for (const gName of ["Hoje", "Ontem", "Anteriores"]) {
        const items = groups[gName];
        if (!items?.length) continue;
        const h = document.createElement("div");
        h.style.cssText = `font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};padding:8px 8px 4px`;
        h.textContent = gName;
        listEl.appendChild(h);

        for (const item of items) {
          const row = document.createElement("div");
          const selected = item.id === focusedId;
          row.style.cssText = `
            display:flex;align-items:center;gap:10px;padding:8px;margin-bottom:2px;
            border-radius:8px;cursor:pointer;
            background:${selected ? C.select : "transparent"};
            border:1px solid ${selected ? "rgba(99,102,241,0.45)" : "transparent"}`;
          const thumb = document.createElement("div");
          thumb.style.cssText = "width:28px;height:28px;flex-shrink:0;border-radius:6px;overflow:hidden";
          if (item.isImage || item.source === "clipboard") {
            thumb.innerHTML = `<div style="width:28px;height:28px;background:${C.surface2};border-radius:6px"></div>`;
            chrome.runtime.sendMessage({ type: "GET_PREVIEW_BYTES", recordId: item.id }).then((prev) => {
              if (!prev?.ok) return;
              const img = document.createElement("img");
              img.style.cssText = "width:28px;height:28px;object-fit:cover;border-radius:6px";
              img.dataset.blob = "1";
              img.src = URL.createObjectURL(new Blob([new Uint8Array(prev.arrayBuffer)], { type: prev.mime }));
              thumb.innerHTML = "";
              thumb.appendChild(img);
            });
          } else {
            thumb.innerHTML = iconSvg(item.category === "pdf" ? "pdf" : item.category === "archive" ? "zip" : "file");
          }
          const meta = document.createElement("div");
          meta.style.cssText = "min-width:0;flex:1";
          meta.innerHTML = `<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${C.text}">${escapeHtml(item.filename)}</div>
            <div style="font-size:10px;color:${C.muted}">${formatSize(item.fileSize)}</div>`;
          row.appendChild(thumb);
          row.appendChild(meta);
          row.onclick = () => {
            focusedId = item.id;
            renderLocalList();
            renderPreview(item);
          };
          row.ondblclick = () => useRecord(item.id, item);
          listEl.appendChild(row);
        }
      }
    }

    async function renderDriveList() {
      listEl.innerHTML = `<div style="padding:20px;color:${C.muted};font-size:12px;text-align:center">Carregando Drive…</div>`;
      driveStatus = await chrome.runtime.sendMessage({ type: "DRIVE_STATUS" });
      if (!driveStatus?.configured) {
        listEl.innerHTML = `<div style="padding:20px 14px;color:${C.muted};font-size:12px;line-height:1.55">
          <b style="color:${C.text}">Google Drive</b><br><br>
          Configure o <code style="color:#A78BFA">oauth2.client_id</code> no manifest
          (Google Cloud → OAuth client).<br><br>
          Escopo: <code style="color:#A78BFA">drive.readonly</code><br><br>
          <span style="opacity:.85">No Chrome: client tipo Extensão do Chrome.<br>
          No Edge: use Chrome, ou client tipo App Web com redirect URI da extensão.</span>
        </div>`;
        renderPreview(null);
        return;
      }
      if (!driveStatus.hasToken) {
        const edgeHint = driveStatus.browser === "edge"
          ? `<div style="margin-top:10px;font-size:11px;color:#FBBF24;line-height:1.4">Microsoft Edge tem suporte limitado ao login Google em extensões. Se falhar, use o <b>Google Chrome</b>.</div>`
          : "";
        listEl.innerHTML = `<div style="padding:24px 14px;text-align:center">
          <div style="color:${C.muted};font-size:12px;margin-bottom:12px">Conecte sua conta Google para listar arquivos do Meu Drive.</div>
          <button id="sf-drive-connect" style="padding:10px 16px;border:0;border-radius:10px;cursor:pointer;font-weight:600;font-size:12px;color:#fff;background:linear-gradient(90deg,#3B82F6,#8B5CF6)">Conectar Google Drive</button>
          ${edgeHint}
        </div>`;
        listEl.querySelector("#sf-drive-connect").onclick = async () => {
          const auth = await chrome.runtime.sendMessage({ type: "DRIVE_CONNECT" });
          if (!auth?.ok) alert(auth?.message || "Falha no login");
          renderDriveList();
        };
        renderPreview(null);
        return;
      }

      const res = await chrome.runtime.sendMessage({ type: "DRIVE_LIST" });
      if (!res?.ok) {
        listEl.innerHTML = `<div style="padding:16px;color:#F87171;font-size:12px;line-height:1.45;white-space:pre-wrap">${escapeHtml(res?.message || res?.error || "Erro")}</div>
          <div style="padding:0 16px 16px;text-align:center">
            <button id="sf-drive-retry" style="padding:8px 14px;border-radius:8px;border:1px solid ${C.border};background:${C.surface2};color:${C.text};cursor:pointer;font-size:12px">Tentar de novo</button>
            <button id="sf-drive-logout2" style="margin-left:8px;padding:8px 14px;border-radius:8px;border:1px solid ${C.border};background:transparent;color:${C.muted};cursor:pointer;font-size:12px">Sair</button>
          </div>`;
        listEl.querySelector("#sf-drive-retry")?.addEventListener("click", () => renderDriveList());
        listEl.querySelector("#sf-drive-logout2")?.addEventListener("click", async () => {
          await chrome.runtime.sendMessage({ type: "DRIVE_DISCONNECT" });
          renderDriveList();
        });
        return;
      }
      driveFiles = res.files || [];
      if (!driveFiles.length) {
        listEl.innerHTML = `<div style="padding:20px 14px;color:${C.muted};font-size:12px;text-align:center;line-height:1.5">
          Nenhum arquivo encontrado no Meu Drive (ou só há pastas/Docs nativos).<br><br>
          Envie um PDF/imagem pelo site do Drive e clique em atualizar.
          <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            <button id="sf-drive-refresh" style="padding:8px 12px;border-radius:8px;border:1px solid ${C.border};background:${C.surface2};color:${C.text};cursor:pointer;font-size:12px">Atualizar</button>
            <button id="sf-drive-logout" style="padding:8px 12px;border-radius:8px;border:1px solid ${C.border};background:transparent;color:${C.muted};cursor:pointer;font-size:12px">Sair da conta Google</button>
          </div>
        </div>`;
        listEl.querySelector("#sf-drive-refresh")?.addEventListener("click", () => renderDriveList());
        listEl.querySelector("#sf-drive-logout")?.addEventListener("click", async () => {
          await chrome.runtime.sendMessage({ type: "DRIVE_DISCONNECT" });
          focusedId = null;
          renderDriveList();
        });
        renderPreview(null);
        return;
      }
      listEl.innerHTML = "";
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px 8px 8px";
      bar.innerHTML = `<span style="font-size:10px;color:${C.muted}">${driveFiles.length} arquivo(s)</span>
        <button id="sf-drive-logout" style="font-size:11px;border:0;background:transparent;color:${C.muted};cursor:pointer;text-decoration:underline">Sair</button>`;
      listEl.appendChild(bar);
      bar.querySelector("#sf-drive-logout").onclick = async () => {
        await chrome.runtime.sendMessage({ type: "DRIVE_DISCONNECT" });
        focusedId = null;
        driveFiles = [];
        renderDriveList();
      };
      for (const f of driveFiles) {
        const row = document.createElement("div");
        const selected = focusedId === f.id;
        row.style.cssText = `
          display:flex;align-items:center;gap:10px;padding:8px;margin-bottom:2px;
          border-radius:8px;cursor:pointer;
          background:${selected ? C.select : "transparent"};
          border:1px solid ${selected ? "rgba(99,102,241,0.45)" : "transparent"}`;
        row.innerHTML = `
          <div style="width:28px;height:28px;border-radius:6px;background:${C.surface2};overflow:hidden;flex-shrink:0">
            ${f.thumbnailLink ? `<img src="${f.thumbnailLink}" style="width:28px;height:28px;object-fit:cover" />` : "☁"}
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.filename)}</div>
            <div style="font-size:10px;color:${C.muted}">${formatSize(f.fileSize)} · Drive</div>
          </div>`;
        row.onclick = () => {
          focusedId = f.id;
          renderDriveList();
          renderPreview({ ...f, isImage: f.category === "image" });
        };
        row.ondblclick = () => useDriveFile(f);
        listEl.appendChild(row);
      }
    }

    async function showTab(name) {
      tab = name;
      setTabs();
      focusedId = null;
      if (tab === "local") {
        await captureClipboard();
        await loadLocalLibrary();
        renderLocalList();
        if (library[0]) {
          focusedId = library[0].id;
          renderLocalList();
          renderPreview(library[0]);
        } else renderPreview(null);
      } else {
        await renderDriveList();
      }
    }

    panel.querySelectorAll(".sf-tab").forEach((b) => {
      b.onclick = () => showTab(b.dataset.tab);
    });

    panel.querySelector("#sf-close").onclick = closeOverlay;
    panel.querySelector("#sf-help-btn").onclick = () => buildHelp(panel);
    panel.querySelector("#sf-native").onclick = () => {
      const t = activeInput;
      closeOverlay();
      allowNativeOnce = true;
      setTimeout(() => {
        try { t?.showPicker ? t.showPicker() : t?.click(); } catch { t?.click(); }
      }, 40);
    };
    useBtn.onclick = async () => {
      if (!focusedId) return;
      if (tab === "drive") {
        const f = driveFiles.find((x) => x.id === focusedId);
        if (f) await useDriveFile(f);
      } else {
        const item = library.find((x) => x.id === focusedId);
        if (item) await useRecord(item.id, item);
      }
    };

    overlayHost.addEventListener("click", (e) => {
      if (e.target === overlayHost) closeOverlay();
    });

    document.addEventListener("keydown", function onKey(e) {
      if (!overlayHost) return document.removeEventListener("keydown", onKey);
      if (e.key === "Escape") {
        closeOverlay();
        document.removeEventListener("keydown", onKey);
      }
      if (e.key === "Enter" && focusedId) {
        useBtn.click();
      }
    });

    await showTab("local");

    const help = await chrome.runtime.sendMessage({ type: "GET_HELP_SEEN" });
    if (!help?.helpSeen) buildHelp(panel);
  }

  function intercept(input) {
    if (allowNativeOnce) {
      allowNativeOnce = false;
      return false;
    }
    openOverlay(input);
    return true;
  }

  document.addEventListener(
    "click",
    (e) => {
      let t = e.target;
      if (t?.closest) {
        const label = t.closest("label");
        if (label) {
          const id = label.getAttribute("for");
          const inp = id ? document.getElementById(id) : label.querySelector('input[type="file"]');
          if (isFileInput(inp)) t = inp;
        }
      }
      if (isFileInput(t) && intercept(t)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  const oc = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (...a) {
    if (isFileInput(this) && intercept(this)) return;
    return oc.apply(this, a);
  };
  if (HTMLInputElement.prototype.showPicker) {
    const os = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function (...a) {
      if (isFileInput(this) && intercept(this)) return;
      return os.apply(this, a);
    };
  }

  document.addEventListener("copy", () => {
    setTimeout(() => captureClipboard().catch(() => {}), 80);
  }, true);

  console.log("[SnapFile] content v0.6 ready");
})();
