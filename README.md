# SnapFile v0.6

Extensão de anexos rápidos (downloads + clipboard + esboço Google Drive).

## Instalar

1. `chrome://extensions` → Modo do desenvolvedor → **Carregar sem compactação**
2. Selecione esta pasta
3. Em **Detalhes** da extensão, ative **Permitir acesso a URLs de arquivo**
4. Abra `test-page.html` e teste

## O que há de novo

- Nome e logo **SnapFile**
- UI opção 3: lista + preview lateral
- Cores do brand (navy / azul→roxo)
- Help na primeira abertura (`?` para reabrir)
- Abas **Local** | **Drive**
- Adapter Google Drive (esboço funcional)

## Google Drive — ativar de verdade

1. [Google Cloud Console](https://console.cloud.google.com/) → criar projeto
2. Ativar **Google Drive API**
3. Credenciais → **OAuth 2.0 Client ID** → tipo **Chrome Extension**
4. Application ID = ID da extensão (em `chrome://extensions`)
5. Colar o client_id em `manifest.json` → `oauth2.client_id`
6. Escopo atual: `drive.file` (mínimo privilégio)

Sem client_id real, a aba Drive mostra instruções (não quebra o Local).

## Atalhos na UI

| Ação | Resultado |
|------|-----------|
| Clique no item | Foca + preview |
| Duplo clique / Enter / Usar arquivo | Anexa no input |
| Esc / ✕ | Fecha |
| Escolher no computador… | Seletor nativo |

## Arquivos

```
manifest.json
background.js          # SW (module)
drive-adapter.js       # Google Drive adapter
content.js             # UI + interceptação
icons/                 # logo + sizes
test-page.html
README.md
```
