**Pre-release.** These are the first desktop and Android builds of Photo Time Machine, made by
the `native-release.yml` workflow from commit `{{COMMIT}}`. They are not store builds: nothing here
is notarized, code-signed by a publisher, or listed in an app store. Version {{VERSION}}.

## What you need first: your own server

The apps are the Photo Time Machine viewer and nothing else. Photos are turned into 3D by a
**Photo Time Machine server that you run**, and the app asks for its address on first start. There
is no demo mode and no shared server: until you give it an address, the app shows only the setup
card. Run the server with `docker compose up` from the repository (it uses the
`ghcr.io/companionintelligence/ci-spatial-photo-server` image, which is published for linux/amd64
only), or install Photo Time Machine on a Companion Hub. See
[Bring your own server](https://github.com/companionintelligence/CI-Spatial-Photo/blob/main/docs/BRING-YOUR-OWN-SERVER.md).

- **Desktop:** choose **This machine** for a server on the same computer (`http://localhost:8000`),
  or enter another address.
- **Android:** on the same network, enter the computer's address and the server's port: `8000` for
  docker compose, `18831` on a Companion Hub, starting with `http://`. Anywhere else use the
  server's HTTPS address (a tunnel, or the Hub's public address).

**Servers from before this release refuse the desktop app.** Server images up to and including
2.0.0 accept the Android app but not the desktop app's origin. Until you update the server, start
it with `ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost`. A Companion Hub install runs
the 2.0.0 server and has no setting for this yet, so on a Hub use the Android app or the website
until the Hub listing is updated.

## Desktop

| File | For |
| --- | --- |
| `photo-time-machine-{{TAG}}-windows-x64-setup.exe` | Windows 10 and 11, installs for the current user |
| `photo-time-machine-{{TAG}}-windows-x64.msi` | Windows, MSI installer |
| `photo-time-machine-{{TAG}}-macos-universal.dmg` | macOS 12 or later, Apple Silicon and Intel |
| `photo-time-machine-{{TAG}}-linux-amd64.deb` | Debian 12, Ubuntu 22.04 and later |
| `photo-time-machine-{{TAG}}-linux-x86_64.rpm` | Fedora and other RPM distributions |

- **Windows** shows SmartScreen ("Windows protected your PC") because the installer is not signed.
  Click **More info**, then **Run anyway**. The app needs the Microsoft Edge WebView2 runtime,
  which Windows 10 and 11 normally have; the installer fetches it if it is missing.
- **macOS:** the app is ad hoc signed, not notarized. Open the disk image and drag the app to
  Applications. The first time, Control-click (or right-click) the app and choose **Open**. If
  macOS only offers to move it to the Bin, open **System Settings > Privacy & Security** and click
  **Open Anyway** next to Photo Time Machine.
- **Linux:** install with your package manager so the WebKitGTK it needs comes too:
  `sudo apt install ./photo-time-machine-{{TAG}}-linux-amd64.deb` or
  `sudo dnf install ./photo-time-machine-{{TAG}}-linux-x86_64.rpm`. There is no AppImage, because
  an AppImage would bundle the LGPL WebKitGTK and GTK libraries.

## Android

{{ANDROID}}

## What the apps can and cannot do

- Create, browse and orbit splats and meshes, and use the webcam head-tracked window (the XR
  button), exactly as on the website, against your server.
- Webcam head tracking downloads its model and runtime from Google's and jsDelivr's CDNs the
  first time it is switched on, as the website does. No video leaves the device.
- WebXR immersive AR is not available inside the apps; use the website in a browser that has it.
- No analytics, no crash reporting and no automatic updates. The server address is stored only
  inside the app.
- External links (ci.computer, the docs) open in your browser.

## Licence and checksums

Photo Time Machine is licensed under the PolyForm Noncommercial License 1.0.0 (`LICENSE`).
`THIRD-PARTY-NOTICES.txt` lists the third-party software inside each app, with the source of the
MPL-2.0 components. The same files are installed with the desktop app and packaged in the APK.
`SHA256SUMS.txt` has the SHA-256 checksum of every file in this release.
