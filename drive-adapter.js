/**
 * SnapFile — Google Drive Adapter v0.6.1
 *
 * Scope: drive.readonly → lista e baixa arquivos reais do usuário
 * Auth: chrome.identity.getAuthToken (Chrome) + fallback launchWebAuthFlow (Edge/outros)
 * Logout: limpa token em cache + revoga no Google
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function isEdge() {
  const ua = navigator.userAgent || "";
  return /Edg\//.test(ua) || /Edge\//.test(ua);
}

function isChromeFamily() {
  // Chrome, Brave, Opera, Vivaldi — not Edge
  return !isEdge() && /Chrome\//.test(navigator.userAgent || "");
}

export class GoogleDriveAdapter {
  constructor() {
    this.token = null;
    this.tokenExpiry = 0;
    this.authMethod = null; // "getAuthToken" | "webAuthFlow"
  }

  getClientId() {
    try {
      return chrome.runtime.getManifest()?.oauth2?.client_id || "";
    } catch {
      return "";
    }
  }

  isConfigured() {
    const id = this.getClientId();
    return !!(id && !id.startsWith("REPLACE_WITH"));
  }

  async ensureAuth({ interactive = true } = {}) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: "oauth_not_configured",
        message:
          "Configure oauth2.client_id no manifest.json (Google Cloud → OAuth → Chrome Extension)."
      };
    }

    if (this.token && Date.now() < this.tokenExpiry - 60_000) {
      return { ok: true, token: this.token, method: this.authMethod };
    }

    // 1) Chrome: getAuthToken
    if (typeof chrome.identity?.getAuthToken === "function") {
      const viaToken = await this._authGetAuthToken(interactive);
      if (viaToken.ok) return viaToken;
      // Se Edge (ou falha explícita de suporte), tenta web flow
      if (viaToken.error === "not_supported" || isEdge() || interactive) {
        const viaFlow = await this._authWebAuthFlow(interactive);
        if (viaFlow.ok) return viaFlow;
        // devolve o erro mais útil
        return viaFlow.error ? viaFlow : viaToken;
      }
      return viaToken;
    }

    return this._authWebAuthFlow(interactive);
  }

  _authGetAuthToken(interactive) {
    return new Promise((resolve) => {
      try {
        chrome.identity.getAuthToken({ interactive }, (token) => {
          const err = chrome.runtime.lastError?.message || "";
          if (err || !token) {
            const notSupported =
              /not supported/i.test(err) ||
              /Microsoft Edge/i.test(err) ||
              isEdge();
            resolve({
              ok: false,
              error: notSupported ? "not_supported" : "auth_failed",
              message:
                err ||
                (notSupported
                  ? "Login Google via getAuthToken não é suportado neste navegador (Edge). Tentando método alternativo…"
                  : "Falha no login Google")
            });
            return;
          }
          this.token = token;
          this.tokenExpiry = Date.now() + 50 * 60 * 1000;
          this.authMethod = "getAuthToken";
          resolve({ ok: true, token, method: "getAuthToken" });
        });
      } catch (e) {
        resolve({
          ok: false,
          error: "not_supported",
          message: String(e.message || e)
        });
      }
    });
  }

  /**
   * Fallback OAuth implicit flow — funciona melhor no Edge se o Client ID
   * tiver redirect URI = chrome.identity.getRedirectURL()
   * (tipo "Aplicativo da Web" no Google Cloud, com esse redirect).
   */
  _authWebAuthFlow(interactive) {
    return new Promise((resolve) => {
      if (!chrome.identity?.launchWebAuthFlow || !chrome.identity?.getRedirectURL) {
        resolve({
          ok: false,
          error: "not_supported",
          message:
            "Este navegador não suporta login Google para extensões. Use o Google Chrome para a aba Drive."
        });
        return;
      }

      const clientId = this.getClientId();
      const redirectUri = chrome.identity.getRedirectURL();
      const scope = encodeURIComponent(SCOPE);
      const url =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&response_type=token` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${scope}` +
        `&prompt=${interactive ? "select_account consent" : "none"}`;

      chrome.identity.launchWebAuthFlow({ url, interactive }, (responseUrl) => {
        const err = chrome.runtime.lastError?.message || "";
        if (err || !responseUrl) {
          resolve({
            ok: false,
            error: isEdge() ? "edge_oauth" : "auth_failed",
            message: isEdge()
              ? "No Microsoft Edge o login Google exige Client ID do tipo “Aplicativo da Web” com redirect URI:\n" +
                redirectUri +
                "\n\nOu use o Google Chrome com Client ID tipo “Extensão do Chrome”.\n\n" +
                (err || "")
              : err || "Login cancelado ou falhou"
          });
          return;
        }
        // responseUrl ...#access_token=...&expires_in=...
        const hash = responseUrl.split("#")[1] || "";
        const params = new URLSearchParams(hash);
        const token = params.get("access_token");
        const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
        if (!token) {
          resolve({
            ok: false,
            error: "auth_failed",
            message: "Token não retornado no redirect OAuth"
          });
          return;
        }
        this.token = token;
        this.tokenExpiry = Date.now() + expiresIn * 1000;
        this.authMethod = "webAuthFlow";
        resolve({ ok: true, token, method: "webAuthFlow" });
      });
    });
  }

  /** Logout completo */
  async revokeAuth() {
    const t = this.token;
    this.token = null;
    this.tokenExpiry = 0;
    const method = this.authMethod;
    this.authMethod = null;

    // Revoga no Google
    if (t) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
      } catch (_) {}
    }

    // Limpa cache do Chrome identity
    if (t && chrome.identity?.removeCachedAuthToken) {
      await new Promise((res) => {
        try {
          chrome.identity.removeCachedAuthToken({ token: t }, () => res());
        } catch {
          res();
        }
      });
    }
    if (chrome.identity?.clearAllCachedAuthTokens) {
      await new Promise((res) => {
        try {
          chrome.identity.clearAllCachedAuthTokens(() => res());
        } catch {
          res();
        }
      });
    }

    await chrome.storage.local.remove(["driveToken", "driveTokenExpiry"]);
    return { ok: true, method };
  }

  async listRecent({ pageSize = 30 } = {}) {
    const auth = await this.ensureAuth({ interactive: true });
    if (!auth.ok) return auth;

    // Arquivos do usuário, não pastas, não lixeira
    const q = encodeURIComponent(
      "trashed = false and mimeType != 'application/vnd.google-apps.folder'"
    );
    const fields = encodeURIComponent(
      "files(id,name,mimeType,size,modifiedTime,thumbnailLink,iconLink,webViewLink)"
    );
    const url =
      `${DRIVE_API}/files?pageSize=${pageSize}` +
      `&orderBy=modifiedTime desc` +
      `&q=${q}` +
      `&fields=${fields}` +
      `&spaces=drive`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.token}` }
      });
      if (res.status === 401) {
        // token morto → limpa e pede de novo
        await this.revokeAuth();
        return {
          ok: false,
          error: "token_expired",
          message: "Sessão expirada. Conecte o Google Drive novamente."
        };
      }
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: "list_failed",
          message: `HTTP ${res.status}: ${text.slice(0, 240)}`
        };
      }
      const data = await res.json();
      const files = (data.files || []).map((f) => ({
        id: `gdrive-${f.id}`,
        driveId: f.id,
        filename: f.name,
        mimeType: f.mimeType,
        fileSize: Number(f.size) || 0,
        modifiedTime: f.modifiedTime,
        thumbnailLink: f.thumbnailLink || null,
        source: "gdrive",
        contentState: "METADATA_ONLY",
        category: (f.mimeType || "").startsWith("image/")
          ? "image"
          : (f.mimeType || "").includes("pdf")
            ? "pdf"
            : "other"
      }));
      return { ok: true, files, count: files.length };
    } catch (err) {
      return { ok: false, error: "list_exception", message: String(err) };
    }
  }

  async downloadFile(driveId) {
    const auth = await this.ensureAuth({ interactive: true });
    if (!auth.ok) return auth;

    // Google Docs nativos não têm bytes binários simples — exportar seria outro fluxo
    const metaUrl = `${DRIVE_API}/files/${encodeURIComponent(driveId)}?fields=mimeType,name,size`;
    try {
      const metaRes = await fetch(metaUrl, {
        headers: { Authorization: `Bearer ${auth.token}` }
      });
      if (!metaRes.ok) {
        return { ok: false, error: "meta_failed", message: `HTTP ${metaRes.status}` };
      }
      const meta = await metaRes.json();
      if ((meta.mimeType || "").startsWith("application/vnd.google-apps.")) {
        return {
          ok: false,
          error: "google_doc",
          message:
            "Arquivos nativos do Google (Docs/Sheets/Slides) precisam de exportação. Por enquanto use PDF/imagens/arquivos enviados."
        };
      }

      const url = `${DRIVE_API}/files/${encodeURIComponent(driveId)}?alt=media`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.token}` }
      });
      if (!res.ok) {
        return { ok: false, error: "download_failed", message: `HTTP ${res.status}` };
      }
      const buffer = await res.arrayBuffer();
      return {
        ok: true,
        buffer,
        size: buffer.byteLength,
        name: meta.name,
        mime: meta.mimeType
      };
    } catch (err) {
      return { ok: false, error: "download_exception", message: String(err) };
    }
  }

  async getStatus() {
    return {
      configured: this.isConfigured(),
      hasToken: !!this.token,
      scope: SCOPE,
      authMethod: this.authMethod,
      browser: isEdge() ? "edge" : isChromeFamily() ? "chrome" : "other",
      redirectUrl:
        typeof chrome.identity?.getRedirectURL === "function"
          ? chrome.identity.getRedirectURL()
          : null,
      note:
        "Escopo drive.readonly lista arquivos reais do Meu Drive. No Edge, preferir Chrome ou Client ID Web com redirect URI."
    };
  }
}

export const driveAdapter = new GoogleDriveAdapter();
