# SnapFile website (GitHub Pages)

Static landing page + privacy policy for [SnapFile](https://github.com/mudot/SnapFile/).

## Enable GitHub Pages

### Option A — `docs/` folder on main branch

1. Copy this folder contents into `docs/` in the SnapFile repo:

```bash
# from your clone of mudot/SnapFile
mkdir -p docs
cp -r path/to/snapfile-site/* docs/
git add docs
git commit -m "Add GitHub Pages site"
git push
```

2. Repo **Settings → Pages → Source**: Deploy from branch **main**, folder **/docs**
3. Site URL: `https://mudot.github.io/SnapFile/`

### Option B — `gh-pages` branch

1. Push these files to a branch named `gh-pages` (root of the branch = site root)
2. Settings → Pages → Source: **gh-pages**

## OAuth consent screen

After Pages is live, set the privacy policy URL in Google Cloud Console to:

`https://mudot.github.io/SnapFile/privacy.html`

## Files

| File | Purpose |
|------|---------|
| `index.html` | Landing page |
| `privacy.html` | Privacy policy (Google OAuth) |
| `logo.png` / `icon.png` | Brand assets |
