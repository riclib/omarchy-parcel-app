# Parcel for Omarchy

Your [Parcel](https://parcelapp.net) deliveries in the Omarchy bar.

A bar badge shows how many parcels are on the way and lights up when one is
out for delivery (or needs attention). Click it for a panel listing every
active shipment with carrier, latest checkpoint and ETA; expand a row for the
full timeline. When a parcel changes state you get a desktop notification.

Parcel is the iOS/macOS tracking app most of us already have on our phone.
This plugin doesn't replace it — it reads the deliveries you've already added
there through Parcel's Premium API, so your desktop and your phone agree.

> **Requires** Omarchy Quattro (`omarchy-shell`) and a [Parcel Premium](https://parcelapp.net/help/premium.html)
> subscription — the API is a Premium feature. Everything else (`curl`, `jq`,
> `secret-tool`, `wl-copy`) ships with Omarchy.

## Install

```bash
omarchy plugin add https://github.com/zuccs/omarchy-parcel-app.git --enable
```

The widget lands in the right section of the bar. Move it with `omarchy bar move`.

## Setup

1. Sign in at [web.parcelapp.net](https://web.parcelapp.net) and generate an API key
   (Settings → API).
2. Store it in your login keyring. `secret-tool` prompts for the value so it never
   touches your shell history:

   ```bash
   secret-tool store --label='Parcel API key' service omarchy-parcel key api-key
   ```

3. Press `r` in the panel (or middle-click the badge). Until a key is stored the
   panel shows these same instructions with a copy button.

Verify from a terminal any time:

```bash
~/.config/omarchy/plugins/io.github.zuccs.parcel/bin/parcel-api status
~/.config/omarchy/plugins/io.github.zuccs.parcel/bin/parcel-api deliveries active | jq
```

## Using it

| Where | Action |
|---|---|
| Badge — left click | Open / close the panel |
| Badge — middle click | Refresh now |
| Badge — right click | Open web.parcelapp.net |
| Panel — `↑` `↓` / `j` `k` | Move between deliveries |
| Panel — `Enter` / `Space` / click | Expand the checkpoint timeline |
| Panel — `y` or `c` | Copy the tracking number |
| Panel — `r` | Refresh now |
| Panel — `o` | Open web.parcelapp.net |
| Panel — `Tab` / `Shift+Tab` | Switch to the neighbouring bar panel |
| Panel — `Esc` | Close |

Bind a key in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + CTRL + SHIFT + P", "Parcel", "omarchy-shell shell toggle io.github.zuccs.parcel")
```

## Settings

Settings live inline on the widget's entry in `~/.config/omarchy/shell.json`,
like every Omarchy bar widget. The defaults:

```json
{ "id": "io.github.zuccs.parcel", "refreshIntervalSec": 600, "filterMode": "active", "notifications": "On", "hideWhenEmpty": "Off" }
```

| Key | Values | Meaning |
|---|---|---|
| `refreshIntervalSec` | `300`–`3600` | How often to poll. Floor is 300 s: Parcel allows 20 requests/hour and manual refreshes count. |
| `filterMode` | `active` / `recent` | `active` shows parcels in progress; `recent` also includes recently delivered ones. |
| `notifications` | `On` / `Off` | Desktop notification when a parcel changes state (e.g. goes out for delivery, or is delivered). |
| `hideWhenEmpty` | `On` / `Off` | Hide the badge entirely when nothing is on the way. |

## How it behaves

- **Rate limits.** The last good response is cached in
  `~/.local/state/omarchy/parcel/` (mode `0600`). Opening the panel or restarting
  the shell reads the cache; only the timer and explicit refreshes hit the API.
  If Parcel returns 429 or the network is down, the cached data stays on screen
  with an "Offline — showing data from …" note.
- **Several monitors, one request.** Each monitor's bar hosts its own copy of the
  widget; the bridge serialises them with `flock`, so they share one fetch and
  one set of notifications.
- **Notifications** compare consecutive fetches: a parcel changing status is
  reported; a parcel that drops out of the list is reported as *no longer active*
  (Parcel's feed doesn't say whether it was delivered or removed — use
  `filterMode: "recent"` if you want explicit *Delivered* transitions); a parcel
  seen for the first time is not reported (your phone already told you).
- **Theme-native.** Colours, fonts, spacing and corner radius come from the
  shell's theme tokens, so it matches whatever Omarchy theme you switch to.

## Privacy & security

- The only network endpoint is `https://api.parcel.app`. The only file written
  is the response cache above.
- Your API key lives in the login keyring (libsecret). It is never written to
  `shell.json`, the QML never reads it, and `bin/parcel-api` hands it to `curl`
  as a config on stdin (`-K -`) rather than as an argument, so it doesn't show
  up in the process list either.
- `bin/parcel-api` is ~200 lines of bash. Read it before you enable the plugin,
  as with any Omarchy plugin.

## Development

```bash
git clone https://github.com/zuccs/omarchy-parcel-app.git ~/.config/omarchy/plugins/io.github.zuccs.parcel
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.zuccs.parcel

omarchy plugin validate ~/.config/omarchy/plugins/io.github.zuccs.parcel
qmllint -I "$OMARCHY_PATH/shell" ~/.config/omarchy/plugins/io.github.zuccs.parcel/*.qml
node --test test/*.test.js           # Model.js is plain JS and unit-tested
PARCEL_API_KEY=… bin/parcel-api deliveries active --max-age 0 | jq   # bridge without a keyring
```

Saving files under `~/.config/omarchy/plugins/` hot-reloads most plugin kinds,
but bar-widget QML is currently cached until the shell restarts
([basecamp/omarchy#8555](https://github.com/basecamp/omarchy/issues/8555)) —
run `omarchy-restart-shell` after editing `BarWidget.qml` or `Panel.qml`.

Layout:

```
manifest.json     plugin identity, settings schema and defaults
BarWidget.qml     bar entry point: badge + Loader for the panel
Panel.qml         popup: fetch lifecycle, notifications, keyboard list
Model.js          pure functions (parsing, sorting, ETA/relative time, diffs)
bin/parcel-api    the only code that touches the network or the API key
data/carriers.json  bundled carrier code → name snapshot; `bin/parcel-api carriers --refresh`
                  caches a newer list in ~/.local/state/omarchy/parcel/, which the widget
                  prefers on its next shell start
test/             node:test suite for Model.js
```

## Roadmap

- Add a delivery from the panel: paste a tracking number, pick the carrier, done
  (`bin/parcel-api add` already exists — Parcel allows 20 adds/day).
- Optional Parcel-style route map for the expanded row.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Parcel or Omarchy.
