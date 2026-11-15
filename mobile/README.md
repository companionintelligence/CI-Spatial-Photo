# Photo Time Machine: Android app

A [Capacitor 8](https://capacitorjs.com) shell around the viewer, for Android. `www/` is a copy
of `web-server/client/build` as the root `npm run build` makes it, the same files
photo.ci.computer serves, and the app adds nothing to them. It has no processing server of its
own and no server address compiled in: on first start it asks for yours. iOS is not part of this
shell.

**A pre-release, not a store build.** The APK is sideloaded, not listed on Google Play. See
[Signing](#signing).

| | |
| --- | --- |
| App ID | `com.companionintelligence.photo` (provisional until a Play listing exists) |
| Name | Photo Time Machine |
| Version | 2.1.0, versionCode 210 |
| Capacitor | 8.6.2 (the CLI needs Node 22 or later) |
| Android | minSdk 24 (Android 7), compileSdk and targetSdk 36, AGP 8.13.0, Gradle 8.14.3, JDK 21 |
| Plugins | none beyond Capacitor core |

## Build

You need Node 22 or later, JDK 21, and an Android SDK with `platforms;android-36` and
build-tools; set `ANDROID_HOME`. Install the viewer's dependencies once (`npm ci` in
`web-server/client`), then:

```sh
cd mobile
npm ci
npm run build            # viewer build, copy, cap sync, notices, cap copy
cd android
./gradlew assembleRelease
```

| Script | Does |
| --- | --- |
| `build:web` | the root `npm run build` (needs a POSIX shell for `env -u`; on Windows use Git Bash) |
| `copy:web` | `scripts/copy-web.mjs`: refuses a build that carries a server address or the analytics tag (`scripts/check-app-viewer.mjs`), then copies it and `LICENSE` into `www/` |
| `sync` | `cap sync android`: `www/` into the Android project, and the generated Gradle files |
| `notices` | `scripts/third-party-notices.mjs build android`: the viewer's npm packages, Capacitor and the Maven libraries on the release classpath, into `www/THIRD-PARTY-NOTICES.txt`. Needs the synced project, because it asks Gradle |
| `art` | `scripts/native-art.mjs`: launcher icons and launch screens from `assets/icon.svg` |

`android/` is the project `cap add android` generated, committed with its edits and without
build outputs or the files `cap sync` writes (see `android/.gitignore`), the same way as
CI-Spatial-Web's shell.

## Scheme and cleartext

The page is served from `http://localhost` (`androidScheme: 'http'`) and the app allows plain
HTTP (`server.cleartext: true`, `android:usesCleartextTraffic="true"`). That follows from how
people reach their server from a phone:

- **The server picker** offers "This machine" (`http://localhost:8000`) and "Same host"; both
  mean nothing on a phone, so the address field is the only way in. Its own copy says a phone
  needs an HTTPS address, but that is a rule about browsers: an HTTPS page cannot load plain-HTTP
  images and meshes.
- **The docs** (`docs/BRING-YOUR-OWN-SERVER.md`) name an HTTPS tunnel or an HTTPS host as the way
  to reach a server from a phone, and say a plain-HTTP LAN address only half-works in a browser.
- **The Hub and its gateway.** A Companion Hub publishes the viewer at an HTTPS address through
  its gateway, and the processing server's API on host port 18831, plain HTTP. Hub installs run
  the 2.0.0 viewer image, which does not pass `/api` through, so from another device today the
  Hub's server is reached at `http://<hub address>:18831`. `docker compose` likewise publishes
  the server on `:8000`, plain HTTP.

So people reach their server either at an HTTPS address, which works with any setting, or at a
plain-HTTP address on their own network, which an HTTPS-only app would refuse outright. On
`http://localhost` there is no mixed content, so with cleartext allowed both kinds work fully:
splats, thumbnails and meshes. Three things keep that safe enough:

- `http://localhost` is still a secure context, so the camera API works.
- The origin is loopback, which every server, 2.0.0 included, already accepts with auth off.
- With auth off, a server's LAN port is already readable by anything on that network, so the app
  adds no exposure. The picker still assumes `https://` for a bare host name.

`allowMixedContent` stays false (it has no effect on an `http://` page) and `CapacitorHttp` stays
off, so `fetch` is the WebView's own and the server's CORS rules mean what they do on the web.
If a later version moves to `https://localhost`, the WebView's storage moves with the origin and
people must enter their server again.

The picker knows it is in this app (`web-server/client/src/utils/nativeShell.ts`): it hides both
presets, says to enter the computer's address and port (8000 for docker compose, 18831 on a
Hub) or an HTTPS address, and warns that a typed `localhost` is the phone itself.

## Permissions

| Permission | Why |
| --- | --- |
| `INTERNET` | the processing server |
| `CAMERA` | the XR button's webcam head tracking (front camera, video only), asked for when it is switched on. The camera is not a required feature, so devices without one can install the app |

Android adds `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, the app's own signature permission from
AndroidX. Links out of the app (ci.computer, the docs) open in the browser: Capacitor hands any
page that is not the app's own to the system.

The app's data is neither backed up nor transferred to another device, because the WebView's
storage holds the server address and, when the server has auth on, its bearer token.
`allowBackup="false"` does that alone on Android 11 and earlier. From Android 12 on, for an app
that targets API 31 or later, it stops cloud backup but, on some manufacturers' devices, not
device-to-device transfers. So `android:dataExtractionRules` points at
`res/xml/data_extraction_rules.xml`, which excludes every data domain from both cloud backup and
device transfer and includes nothing. On a new phone, people enter their server again.

## Signing

Release builds are not debuggable, and are signed only when all four of
`ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` are set (`android/app/build.gradle`); some but not all fails the build.
Without them `assembleRelease` writes an unsigned APK. Nothing about a key is ever written into
this directory, and `.gitignore` refuses keystores.

The release workflow (`.github/workflows/native-release.yml`, input `android_signing`):

| Mode | Key |
| --- | --- |
| `auto` (default) | the keystore secrets when they are set, otherwise `throwaway` |
| `keystore` | `ANDROID_KEYSTORE_BASE64` (decoded into the runner's temp directory), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (defaults to the store password) |
| `throwaway` | a key made with `keytool` for that run and deleted after it |
| `skip` | no APK |

The APK is named for its key: `...-android-release-signed.apk` or
`...-android-throwaway-signed.apk`. Android installs an update only over an app signed with the
same key, so a throwaway-signed APK can never be updated in place: people uninstall it first,
which also clears the server address it remembers. Create the release keystore and its secrets
before any build people should keep.

## Icons and launch screens

`npm run art` draws them from `assets/icon.svg`, the source of the web and desktop icons, with
`@resvg/resvg-js`: the legacy and round launcher icons, an adaptive icon (the tile's gradient
behind, the two frames in front inside the safe zone, the frames again as the Android 13 themed
icon) and the launch screens, the icon on the viewer's ground colour `#041620`. Android 12 and
later draw their own launch screen from the adaptive icon on the same colour. None of Capacitor's
placeholders remain; `tests/native-config.test.mjs` checks every size and that no placeholder
came back.

## Licences

The APK carries `LICENSE.txt` (PolyForm Noncommercial 1.0.0) and `THIRD-PARTY-NOTICES.txt` in its
assets; inside the app they are at `http://localhost/LICENSE.txt` and
`http://localhost/THIRD-PARTY-NOTICES.txt`. The notices list the viewer's npm packages, Capacitor
(MIT) and the AndroidX, Kotlin and Cordova libraries (Apache-2.0), with their licence texts. They
cover the viewer and this app only. The desktop installers carry the viewer's and the desktop
app's notices instead, and only the `THIRD-PARTY-NOTICES.txt` attached to a release, which the
release workflow renders from every part it built, lists all of them.

## Verified, and not

Verified on Windows with the Android SDK (local build): `cap sync android` and
`./gradlew assembleRelease` with a throwaway key made outside the clone; `apksigner verify` (v2
scheme, one signer); `aapt2 dump badging` (package, label "Photo Time Machine", versionName
2.1.0, versionCode 210, INTERNET and CAMERA, minSdk 24, targetSdk 36, not debuggable); the
notices and licence in the APK's assets; `aapt2 dump xmltree` of the merged manifest
(`allowBackup` false, `dataExtractionRules` pointing at the rules) and of the compiled rules
(all nine domains excluded from both cloud backup and device transfer). On an Android 15
emulator (WebView 124, software rendering), the release APK showed the setup card without
presets and with the phone's copy, connected to a plain-HTTP server on the host, loaded a
gallery thumbnail and rendered a splat, and the footer's Docs link opened Chrome. Not run: a
physical device, the camera prompt and head tracking, an HTTPS server, Android versions before
15, and a real cloud backup or device-to-device transfer.

## Before a store build

- Choose the permanent application id; an Android id cannot change once uploaded.
- Create the release keystore and store it as the four Actions secrets.
- A privacy policy and Play's data-safety answers: photos go to the user's own server.
- Decide whether plain HTTP stays allowed for a store build, and whether Android's coming local
  network permission needs declaring for the target SDK in use.
