# Photo Time Machine: desktop app

A [Tauri 2](https://v2.tauri.app) shell around the viewer for Windows, macOS and Linux. It
bundles `web-server/client/build` exactly as the root `npm run build` makes it, the same files
photo.ci.computer serves, and adds nothing to them. Like the website, the app has no processing
server of its own and no server address compiled in: on first start it asks for yours.

**A pre-release, not a store build.** Windows and Linux installers are unsigned, and the macOS
app is ad hoc signed and not notarized. See [Publishing](#publishing).

| | |
| --- | --- |
| Name | Photo Time Machine |
| Identifier | `computer.ci.photo`, **provisional** (see [Before a store build](#before-a-store-build)) |
| Version | 2.1.0 (`tauri.conf.json`, `Cargo.toml` and `package.json` agree; `tests/` checks) |
| Tauri | crate 2.12.5, tauri-build 2.7.4, tauri-plugin-opener 2.7.3, CLI 2.12.4; `src-tauri/Cargo.lock` is committed |
| Installers | Windows NSIS `.exe` and `.msi`; macOS `.dmg` (universal); Linux `.deb` and `.rpm`. Never an AppImage |
| macOS | 12 or later, ad hoc signed (`signingIdentity: "-"`) |

## Build

You need Node 22 or later, a Rust toolchain (1.90 or later) and
[Tauri's system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.
Install the viewer's dependencies once (`npm ci` in `web-server/client`), then:

```sh
cd desktop
npm ci
npm run build      # viewer build, notices, icons, then `tauri build`
```

`npm run build` runs four steps, and each can be run on its own:

| Script | Does |
| --- | --- |
| `build:web` | the root `npm run build` (which unsets `REACT_APP_API_BASE`), then `scripts/check-app-viewer.mjs`, which refuses a build carrying a server address or the Google Analytics tag |
| `notices` | `scripts/third-party-notices.mjs build desktop`: the viewer's npm packages and the Rust crates in the binary, into `src-tauri/notices/` |
| `icons` | `tauri icon ../assets/icon.svg`: every desktop icon from the repo's app icon, into `src-tauri/icons/` |
| `tauri build` | the installers, under `src-tauri/target/release/bundle/` |

The root build unsets `REACT_APP_API_BASE` with `env -u`, which needs a POSIX shell. On Windows,
point npm at Git Bash for that one command: `npm --script-shell <path to Git's bash.exe> run build`
at the repo root. Leave `GA_MEASUREMENT_ID` unset; the check fails if the build has analytics in
it.

`npm run dev` opens the app on the viewer's dev server (`npm start` in `web-server/client`,
port 3000), which you start first.

## What the shell does

- **Links leave the app.** The viewer's links to ci.computer, the docs and the shop are same-tab
  links. The window is built in `src-tauri/src/main.rs` with navigation and new-window handlers:
  anything that is not one of the app's own pages opens in the system browser through
  `tauri-plugin-opener`, and the window stays where it was.
- **Files can be dropped.** `dragDropEnabled` is off, because Tauri's own drop handler would
  otherwise swallow file drops on Windows and the Create panel's dropzone is HTML5 drag and drop.
- **The camera works for head tracking.** `Info.plist` adds `NSCameraUsageDescription` (macOS
  ends an app that opens the camera without it) and `Entitlements.plist` the camera entitlement
  the hardened runtime asks for. WebView2 and WebKitGTK ask for permission themselves.
- **Plain HTTP on the local network is allowed on macOS.** `NSAllowsLocalNetworking` lets the app
  reach `http://localhost:8000` and a LAN server; everything else keeps App Transport Security.
- **Zoom.** Ctrl and Cmd plus and minus zoom the page (`zoomHotkeysEnabled`).
- **Permissions.** The window gets `core:default` only. The viewer never calls a Tauri API.

## Server origin

The app's page is `tauri://localhost` on macOS and Linux and `http://tauri.localhost` on Windows.
With auth off, a server accepts those origins from the version after 2.0.0 on
(`server/app/config.py`, `DESKTOP_APP_ORIGINS`). A 2.0.0 server refuses them, and the setup card
then says it could not reach the server: start that server with
`ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost`. A Companion Hub install runs the
2.0.0 server and cannot set that yet.

The server picker knows it is in the app (`web-server/client/src/utils/nativeShell.ts`): it drops
**Same host as this page**, because no server answers on the app's own origin, and keeps
**This machine** for a server on the same computer.

## Content security policy

`app.security.csp` is `null` on purpose, and `tests/native-config.test.mjs` pins it. The only
policy written for this viewer is the Cloudflare Worker's report-only one in `worker/index.js`,
which has never been enforced anywhere: the worker says why, since blob: workers, WASM
compilation and the MediaPipe CDN all have to be measured in a real browser first, and getting
any of them wrong breaks splats or head tracking. Enforcing it here would mean measuring it in
WebView2, WKWebView and WebKitGTK. The app loads only its own bundled files, so a policy would
guard the same code the website runs without one. Set one when it has been tested on all three
platforms with a splat loaded and head tracking running.

## Licences

Every installer carries `LICENSE.txt` (PolyForm Noncommercial 1.0.0; NSIS and MSI show it) and
`THIRD-PARTY-NOTICES.txt`, installed next to the app (`bundle.resources`). The notices cover the
viewer's npm packages and every Rust crate linked into the binary on any desktop target, with
the source of the MPL-2.0 crates (cssparser, cssparser-macros, dtoa-short, option-ext,
selectors). They are generated from the lockfiles at build time and never committed. On Linux
the app uses the distribution's WebKitGTK and GTK (LGPL) through the package's dependencies; an
AppImage would bundle them, which is why there is none.

## Publishing

`.github/workflows/native-release.yml` builds all three platforms from one viewer build and
publishes a GitHub pre-release. It is dispatch-only, like every workflow here. The macOS app is
ad hoc signed, so Apple Silicon offers **Open Anyway** instead of calling the download damaged,
and the release notes tell people how to get past SmartScreen and Gatekeeper.

## Verified, and not

Verified on Windows 11 (local build): the NSIS and MSI installers build; the MSI holds the app,
`LICENSE.txt` and `THIRD-PARTY-NOTICES.txt`; the app starts and stays up; from
`http://tauri.localhost` it connects to a local server through **This machine**, creates a splat
with the preview engine and renders it; the setup card offers only **This machine**. Not run:
the macOS and Linux builds (they run in the release workflow only), the camera in any of the
three webviews, a plain-HTTP LAN server from macOS or Linux, and the link handlers on a real
click (their rules have unit tests in `main.rs`).

## Before a store build

- Choose the permanent identifier. `computer.ci.photo` is provisional; changing it later moves
  the app's stored data (its server address) and makes it a different app to each OS.
- Sign: an Apple Developer ID with notarization for macOS, and a code-signing certificate for
  Windows.
- Decide on a content security policy (above).
