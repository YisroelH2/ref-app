# YKP-refs — Camp Sports Referee Toolkit

A mobile-first web app for camp sports referees, built with Vite + React + Tailwind CSS.

## Project structure

```
index.html              Vite entry HTML
src/main.jsx             React root
src/App.jsx              Screens: Home, Volleyball, Football, Universal (soccer/hockey/baseball), Basketball
src/index.css            Tailwind directives + global/keyframe CSS
src/components/          Shared components (Icon, IconButton, Sheet, ...)
public/                  manifest.json, icons, sw.js — copied as-is into the build output
legacy/index.html         The old single-file (no-build, CDN-script) version, kept for reference
```

## Run locally

```
npm install
npm run dev
```

## Build

```
npm run build   # outputs to dist/
npm run preview # serve the production build locally
```

## Deploy to GitHub Pages

Deployment is automated via `.github/workflows/deploy.yml`, which builds with Vite and publishes `dist/` on every push to `main`.

One-time setup: in the repo, go to **Settings → Pages** and set **Source** to `GitHub Actions` (not "Deploy from a branch" — that only works for static files, and this project now has a build step).

The app is served at `https://<username>.github.io/ref-app/` — note the `base: '/ref-app/'` in `vite.config.js` matches this subpath; update it if the repo is ever renamed.

## Features

- **Global smart timer** — enter the time an activity ends, the app splits the remaining time into two even halves and counts down. Tap the timer to pause/resume (turns red + pulses when paused).
- **Volleyball** — serve indicator, Point / Side-out buttons, serve streak counter.
- **Football** — TD/FG/XP/2PT scoring, per-team timeout tracker (configurable count and per-half/per-game reset), one-tap undo of the last score.
- **Soccer / Hockey / Basketball / Baseball** — split-screen tap-to-score, period/inning tracker.
- All game state and the running timer persist to `localStorage`, so an accidental refresh won't lose the score.
