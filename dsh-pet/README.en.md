# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=monthly&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=total&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI: idle breathing, random actions (including dozing off), occasional turns, screen wandering, click reactions, and draggable.

---

## 🚀 Quick Start (Install the Plugin)

```sh
dsh plugin --profile web add dsh-pet          # the only published format: webm (VP9-alpha)
```

Restart `dsh web` and the pet appears in the bottom-right corner — all transparent animations, ready to use out of the box, no generation pipeline required.

> 💡 Single format (injected at publish time; no runtime browser sniffing): only `.webm` (VP9-alpha), shared by browser Chrome/Edge/Firefox and the desktop mode (Electron = Chromium). Safari does not support webm alpha (black background); for Safari/HEVC compatibility, fork the repo, enable the kept pipeline (`scripts/encode_hevc_alpha.sh` + `hevc-alpha.yml`) and re-add the `.mov` branch in the host thumb route (`src/host/index.ts`) yourself — the plugin itself never publishes or supports `.mov`.

> 💡 Want to craft your own one-of-a-kind pet? Clone [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) and use the bundled asset pipeline (AI prompts → green-screen video → transparent animation, generated with Doubao) to generate one from scratch — fully reproducible.

## 🪟 Desktop mode (optional, outside the browser)

Besides the browser overlay, the plugin automatically spawns a **standalone transparent always-on-top window** (Electron, full-workarea canvas + click-through) so the pet can live on your desktop. It is **strictly behavior-identical to the browser overlay** — one shared pure-logic source (`src/shared/`, compiled into the browser bundle and the desktop `shared-core.js` / `window.PetShared`):

- Same pet features on both sides, always: multiple pets on screen, corner + margin placement, the same animation chain / click / drag / balance tier animations with the rich balance bubble. (System notifications are a standalone capability — the browser half's `notify.ts` monitors DSH events and toasts; it is independent of the pet itself and therefore not copied to the desktop pet)
- **On/off = the required per-pet `display` field**: `web` = browser only / `desktop` = desktop only / `both` = both / `none` = neither; the desktop window renders **all** pets with `display ∈ {desktop, both}`, each using its own size/corner config
- Requires Electron (auto-detected, auto-downloaded to `~/.dsh/electron/` as a fallback; if missing, it only logs a warning and the browser overlay keeps working)
- Same animation assets as the browser (`/dsh-pet-7340/thumb/<name>.webm`, user `main-animation/` takes precedence); config failures **fail loudly** (red error bar + 5s auto-retry), never a silent fallback

## ✨ Features

- **A pure pet, nothing else**: no business features — no weather, no monitoring, no agent-state sensing; just a companion. Zero core changes, zero model cost (no LLM/API calls at runtime)
- **Hand-drawn style transparent animations**: idle breathing, dozing off, playing with a Rubik's cube, humming, hair-raising, blowing bubbles, playing with a water gun, playing violin, the whale emerging, eating rice, looking in the mirror, three dances, writing code, seasonal actions (kite flying, snowman building, ice cream eating, fireworks…) — all seamlessly chained
- **Never-ending animation chain**: when each animation finishes, the next one is picked instantly by probability (30% idle / 10% turn / 40% action / 20% move)
- **Screen wandering**: walks toward its facing direction, checks the space ahead and never walks off screen
- **Click / drag**: click triggers a random reaction animation (happy / shy / tsundere); drag it anywhere
- **Left/right facing**: all animations are CSS-mirrored, the pet can face left or right
- **Ground alignment**: animations share a unified foot line, the pet always stands on the "ground"
- **Smooth transitions**: double-buffered video cross-fade, zero blank frames between switches
- **Accessibility-friendly**: supports `prefers-reduced-motion`

## ⚙️ Configuration

| Key        | Description                                   | Current status                                                                        |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `size`     | Stage width (px); pet height ≈ width×9/16×74% | Default 462 (≈260px tall); editable per pet via the settings page (applies instantly) |
| `position` | Default corner position                       | Defaults to bottom-right; editable per pet via the settings page (applies instantly)  |

> Note: the plugin works out of the box; all config above is optional. Settings-page edits are saved to `$DSH_HOME/dsh-pet/main-config.json` (user layer, takes precedence over the packaged defaults).
> ⚠️ The legacy paths `$DSH_HOME/pet-config.json` / `$DSH_HOME/pet-assets` (pre-v0.1.6) are no longer read — migrate manually after upgrading.

### 📄 Advanced customization (edit config files directly)

All user data lives under `$DSH_HOME/dsh-pet/` (one directory per plugin; future character packs follow the same pattern with their own plugin id):

| Layer                      | Path                                 | Purpose                                                                                                                                        |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Default config (read-only) | `assets/config.jsonc` in the package | Complete reference: pet list / animation pools (idle/turn/drag/clicks/moves/categories) / playback weights                                     |
| User config                | `$DSH_HOME/dsh-pet/main-config.json` | Override fragment: optionally override `pets` / `animations` / `animationWeights`; missing fields fall back to defaults                        |
| User animations (optional) | `$DSH_HOME/dsh-pet/main-animation/`  | Drop `.webm` (VP9-Alpha) files here to make them playable — **takes precedence over the packaged assets** (put them in `main-animation/webm/`) |

- The settings page shows these paths at the bottom
- Custom animations: put `xxx.webm` into `main-animation/webm/`, name it in an animation pool/category as `"xxx"`, then **refresh the page** (no DSH restart needed)
- Format: `.webm` requires **VP9 Alpha** encoding (Chrome/Edge/Firefox) — same spec as the packaged assets; a plain encode will show a black background
- After editing the user config, **refresh the page** to apply
- Fill animation names by referring to the default config to avoid referencing missing animations

## 🗑️ Uninstall

```sh
dsh plugin --profile web remove dsh-pet
```

## 🖥️ Running Screenshots

What the pet looks like running inside the DSH Web UI:

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
</p>

## 🎬 Animation Previews

> The animations have transparent backgrounds; in these GIF previews the transparent areas show the page background color, while the actual playback (webm) is transparent.

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="Idle breathing & chill" title="Idle breathing & chill">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="Looking around" title="Looking around">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="Floating in place" title="Floating in place">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="Napping" title="Napping">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="Click response - happy bounce" title="Click response - happy bounce">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="Dragged by the mouse" title="Dragged by the mouse">
</p>

All animations live in the repo under `dsh-pet/assets/webm/` (VP9-alpha, the only published format).

## 📚 A Complete Project (More Than a Plugin)

This is a **complete three-piece project** — anyone can clone the repo and generate their own desktop pet from scratch:

```
① Prompts (recipe)      →  ② Asset pipeline (engine)  →  ③ Plugin (product)
AI animation prompts        source video → transparent       the pet running in DSH
```

- Repository: [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- Design & implementation docs: [DESIGN.md](https://github.com/PC2005-cloud/dsh-pet/blob/master/DESIGN.md)

## 🔎 Discover More DSH Plugins

- Community plugin catalog: [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH official repository: [deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 License

- Code: MIT
- Assets (animations/prompts/source videos): open-source use permitted, **no commercial use**
