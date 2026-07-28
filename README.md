# RefCourt — Camp Sports Referee Toolkit

A single-file, mobile-first web app for camp sports referees. No build step — just static HTML.

## Run locally

Open `index.html` directly, or serve it (recommended, since some browsers restrict `file://` pages):

```
npx serve .
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to `Deploy from a branch`, pick your branch (e.g. `main`) and `/ (root)`.
4. Save — your app will be live at `https://<username>.github.io/<repo>/` within a minute or two.

## Features

- **Global smart timer** — enter the time an activity ends, the app splits the remaining time into two even halves and counts down. Tap the timer to pause/resume (turns red + pulses when paused).
- **Volleyball** — serve indicator, Point / Side-out buttons, serve streak counter.
- **Football** — TD/FG/XP/2PT scoring, per-team timeout tracker (configurable count and per-half/per-game reset), one-tap undo of the last score.
- **Soccer / Hockey / Basketball / Baseball** — split-screen tap-to-score, period/inning tracker.
- All game state and the running timer persist to `localStorage`, so an accidental refresh won't lose the score.
