import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Photo Time Machine Android app.
 *
 * The app is the viewer and nothing else: `www` is a copy of web-server/client/build, made by
 * the root `npm run build` with no server address and no analytics (scripts/copy-web.mjs).
 * There is no `server.url`, so no remote page and no live reload. Like the website, the app
 * asks for the user's own processing server on first start.
 *
 * Scheme and cleartext follow how people reach that server from a phone (mobile/README.md,
 * "Scheme and cleartext"): an HTTPS tunnel or Hub address, or a plain-HTTP address on their
 * own network, such as the Hub's server port 18831 or docker compose's :8000. A browser on an
 * HTTPS page can only half-load the second kind. Here the page is http://localhost, so there
 * is no mixed content to block, and cleartext is allowed so that such an address works. That
 * origin is a secure context (localhost), so the camera still works, and the server's
 * loopback CORS rule already accepts it.
 */
const config: CapacitorConfig = {
  appId: 'com.companionintelligence.photo',
  appName: 'Photo Time Machine',
  webDir: 'www',
  // The viewer's ground colour (theme_color in public/manifest.json), so the strips behind
  // the web view and the launch screen match it.
  backgroundColor: '#041620',
  server: {
    // The page is served from http://localhost.
    androidScheme: 'http',
    // Plain HTTP to the user's own server on their network. Written into the manifest by
    // `cap sync`; AndroidManifest.xml also states it.
    cleartext: true,
  },
  android: {
    // Pinch-zoom stays on (WCAG 1.4.4). Capacitor's default is off.
    zoomEnabled: true,
    // Irrelevant on an http:// page, and kept at the safe value.
    allowMixedContent: false,
  },
  plugins: {
    // fetch and XMLHttpRequest stay the WebView's own, so CORS applies as it does on the
    // website and the server's origin allowlist means the same thing here.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
