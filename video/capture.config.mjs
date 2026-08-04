/**
 * Capture stage for Photo Time Machine.
 *
 * `ci-video capture` drives the REAL app through this config, so whatever it
 * takes to get a brand-new user to a filmable screen belongs here: the base
 * URL, any pre-authenticated session, route mocks, and seeding.
 *
 * ── The stage ────────────────────────────────────────────────────────────────
 * This repo is TWO processes, not one (docker-compose.yml, README "Quick start"):
 *
 *   viewer  :3000  web-server/client   CRA SPA (nginx in the container image)
 *   server  :8000  server/app          FastAPI — REST /api/v1, MCP /mcp, /healthz
 *
 * The SPA is an empty shell without the server: CreatePanel populates its Engine
 * select from `GET /api/v1/engines` on mount (components/CreatePanel.tsx), and
 * Gallery / MemoryPicker are pure API views. There is no `webServer` config to
 * reuse — this repo has NO Playwright at all, so `.github/workflows/video.yml`
 * boots the stage by hand.
 *
 *   pip install -e ./server
 *   uvicorn app.main:app --app-dir server --host 127.0.0.1 --port 8000   # AUTH_DISABLED=1 by default
 *   REACT_APP_API_BASE=http://127.0.0.1:8000 npm run build --prefix web-server/client
 *   npx serve -s web-server/client/build -l 3000
 *
 * ── Determinism hazards found while reading the source ───────────────────────
 *  1. REACT_APP_API_BASE is baked in at CRA BUILD time (web-server/client/src/api.ts
 *     line 3, Dockerfile ARG). A container built for one host talks to that host
 *     forever. The stubs below match on `**\/api/v1/**` regardless of origin, so
 *     they survive a wrong API base — but an UNSTUBBED shot will not.
 *  2. `GET /api/v1/engines` is environment-dependent. TripoSplat / SHARP /
 *     photogrammetry report `available:false` with a machine-specific
 *     `unavailable_reason` unless CUDA + weights are present (server/app/engines/*.py),
 *     so the Engine dropdown differs between a laptop, CI, and a GPU box.
 *     STUBBED to a fixed list below.
 *  3. Jobs are real background tasks (`asyncio.create_task` in server/app/jobs.py)
 *     and the client polls every 1500 ms (`waitForJob` in api.ts). The CPU Preview
 *     engine finishes a small image in well under one poll, so the "Status: running"
 *     frame is a RACE against a live server — the app would jump straight to the
 *     Explore tab. STUBBED to a pinned running job so the beat is filmable.
 *  4. Asset ids (`a_<hex>`) and `created_at` are generated per run. Gallery prints
 *     `new Date(a.created_at).toLocaleString()` (Gallery.tsx) and the share footer
 *     prints `asset.share_url` (App.tsx) — the only two volatile strings the asset
 *     screens put on camera. Both are now PINNED by rewriting `GET /assets` and
 *     `GET /assets/:id` in flight (see the route table). The REAL `asset_id` is left
 *     untouched, so `/assets/:id/file` and `/assets/:id/thumbnail` still resolve
 *     against the live server — the gallery tile and the orbited splat are the
 *     genuine article, not a mock. `.github/workflows/video.yml` seeds that asset
 *     through the real POST /jobs before capture runs.
 *  5. The viewer is a Three.js + Spark SplatMesh WebGL2 canvas
 *     (components/SplatViewer.tsx). Headless Chromium under the kit's launch args
 *     does expose WebGL2 through ANGLE/SwiftShader, including the
 *     EXT_color_buffer_float / EXT_float_blend / OES_texture_float_linear set a
 *     3DGS renderer needs, so the viewer shots rasterise on ubuntu-latest with no
 *     GPU. SwiftShader is deterministic within a Chromium build, so these frames
 *     are byte-stable until Playwright is bumped — at which point the drift job
 *     opens a PR, which is exactly what it is for. Left unmasked deliberately: a
 *     masked canvas would defeat the point of the shot.
 *  6. XR mode calls `getUserMedia` and pulls the MediaPipe FaceLandmarker WASM
 *     from a CDN (hooks/useHeadTracking.ts). Never enable XR during capture —
 *     no camera in CI, and the CDN fetch is a network dependency.
 *  7. `MemoryPicker` ALWAYS paints its Photos/Videos toggle (MemoryPicker.tsx), so
 *     the From Memory screen is reachable in CI — it is the grid CONTENTS that are
 *     environment-dependent. With CI_MEMORY_MCP_URL unset, MemoryClient._call_tool
 *     returns None and `GET /memory/media` answers `{"media": []}`
 *     (server/app/memory.py), so the panel reads "No media in Companion memory (or
 *     memory not configured)." — NOT "Companion memory is not connected.", which is
 *     the fetch-rejected branch this comment used to claim. STUBBED below to a fixed
 *     set for the same reason /engines is: the screen is real, the library is the
 *     user's, and CI has no Companion Memory to borrow one from.
 *  8. Routing is a hand-rolled regex, not a router: `parseViewId()` in App.tsx
 *     matches only `^/view/([A-Za-z0-9_]+)`. Every other screen — Explore, From
 *     Memory, the share footer — is INTERACTION STATE on `/`, reached via
 *     `capture.before`, never via a path.
 */

/** The API origin the SPA bundle was built against (must match REACT_APP_API_BASE). */
const API_BASE = process.env.PTM_API_URL ?? "http://localhost:8000";

/**
 * A real 48x48 PNG, inlined so capture never touches the network or the repo's
 * (gitignored) data/ directory. Content is irrelevant while POST /jobs is stubbed;
 * it is a valid image so that dropping the stubs still produces a real Preview job.
 */
const FIXTURE_PNG =
  "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";

export default {
  // The CRA viewer. `npm run capture` never boots it — see the workflow.
  baseURL: process.env.PTM_VIEWER_URL ?? process.env.APP_URL ?? "http://localhost:3000",

  // The app hard-codes dark chrome (App.tsx defaults isDarkMode = true, the
  // viewer background is bg-black), so the context matches it. Pinned
  // locale/timezone/clock keep `toLocaleString()` output stable.
  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: "2026-06-15T15:04:00Z",

  // No storageState: AUTH_DISABLED defaults to true (server/app/config.py) and the
  // client only sends a bearer token when localStorage has `ci_token` (api.ts).
  // With Companion OIDC on, capture would need a token seeded into localStorage.
  // storageState: "./.auth/state.json",

  async onContext(context, { viewport }) {
    // An unstyled capture looks like a UI regression but is usually a failed
    // external asset. Say so loudly.
    context.on("requestfailed", (req) => {
      if (/fonts\.(googleapis|gstatic)|cdn\.|jsdelivr|unpkg/.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });

    // The dropzone is a hidden <input type=file> (react-dropzone), and the kit's
    // `before` verbs cannot set one — `fill` is rejected by Playwright on file
    // inputs. Expose a helper the storyboard calls via `eval` instead. It builds
    // the File in-page from the inlined PNG and dispatches a real `change`, which
    // is what react-dropzone's getInputProps() onChange listens for.
    await context.addInitScript((b64) => {
      window.__ciVideoPickFixture = async () => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], "porch-1998.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.querySelector('input[type="file"]');
        if (!input) throw new Error("dropzone file input not found");
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
    }, FIXTURE_PNG);

    // ── Route stubs ──────────────────────────────────────────────────────────
    // Only the two endpoints that are genuinely non-deterministic (hazards 2 and
    // 3 above). Everything else falls through to the real FastAPI server, so the
    // frames are the real UI rendering real response shapes — the shapes below
    // are copied from server/app/models.py (EngineCapabilities, Job).
    const json = (route, body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });

    const ENGINES = [
      {
        name: "preview",
        description:
          "CPU-only instant preview: image -> flat textured Gaussian plane. No GPU or weights required.",
        inputs: ["image"],
        intents: ["auto", "scene"],
        output_kind: "splat",
        output_formats: ["ply"],
        commercial: true,
        requires_gpu: false,
        license: "MIT (this project)",
        available: true,
        unavailable_reason: null,
      },
      {
        name: "triposplat",
        description: "Single image -> 3D Gaussian splat. MIT code and weights.",
        inputs: ["image"],
        intents: ["auto", "object"],
        output_kind: "splat",
        output_formats: ["ply", "spz"],
        commercial: true,
        requires_gpu: true,
        license: "MIT",
        available: true,
        unavailable_reason: null,
      },
      {
        name: "sharp",
        description: "Apple SHARP: single image -> scene splat. Research weights, non-commercial.",
        inputs: ["image"],
        intents: ["scene"],
        output_kind: "splat",
        output_formats: ["ply"],
        commercial: false,
        requires_gpu: true,
        license: "Apple ML Research Model License (non-commercial)",
        available: true,
        unavailable_reason: null,
      },
      {
        name: "photogrammetry",
        description: "Image set or video -> COLMAP poses -> gsplat optimisation.",
        inputs: ["images", "video"],
        intents: ["auto", "scene"],
        output_kind: "splat",
        output_formats: ["ply", "spz"],
        commercial: true,
        requires_gpu: true,
        license: "Apache-2.0 / BSD",
        available: true,
        unavailable_reason: null,
      },
    ];

    // A fixed Companion memory library (hazard 7). Thumbnails are inlined data URIs
    // so the grid needs no network and no Companion Memory server: MemoryPicker.tsx
    // puts `thumbnail_url` straight into an <img src>. Shape from api.ts MemoryMedia
    // / server/app/models.py MemoryMedia. These stand in for the user's own photos —
    // the ONLY thing CI cannot supply — exactly as the /engines stub stands in for a
    // GPU box.
    const MEMORY_MEDIA = [
      { ref: "mem_0f21", kind: "image", title: "Porch at sunset, 1998", thumbnail_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wAARCACAAIADASIAAhEBAxEB/8QAGwABAQADAQEBAAAAAAAAAAAAAAMBAgQFBgf/xAApEAACAgEDAgUFAQEAAAAAAAAAAQISAwQFETFBEyFRYYEGInGRocHR/8QAGAEBAQEBAQAAAAAAAAAAAAAAAAEDAgT/xAAeEQEBAAIDAQEBAQAAAAAAAAAAEQECAxIxIVEEQf/aAAwDAQACEQMRAD8A+TqKlaip6K5iVRUrUVFIlUVK1CiKRKoqVqKikSqKlqmKikSqKllEVFIjXzFStRUUiVRUrUVFIrUVLVMVMq7iVRUrUzUtIjQzUrUVJSJV8xUtUUFIjUV9S1RX2FIjUVLUM0HZYhUV8y1BUVIjUVK1FeRSK1FStRUyrSJVFSqiZqKRKoqVqZUBSI1M1LKBsoDsRBQMqBehmhOyxz0FDpoPDJ2I5aCh0OBhwL2I56mKnQ4GtS9kilRUrUVM67iSiKlqhRJSJKJsoFFE2UBViSgbqHsVjApHGc52WIrGbeGdEcZusfsc9l6uXwzDxnZ4XsHi9id16uFwNHA7njJyxlxskcbh7GrgdUoGjid42cwqKlqipxXcSqZUTTUanDpo2zZIwXv3/COWO86FxTeVxfHRxfkX7nxPmHcom6iedk3vRQg2sjm/SMXy/wBk9Dv+HNmcc6WFN/a+eV8sddvYXD2YwKxgbQSZeEDHOzTGE44yscXoWhA6cWEyzu7xq4/BZrLF7Fdw3PQbbKMNXnjjnJcqPDb4+Dxtw+qtvxY+dM5aib7JOKX5bX+MuuN9vMOc51x/rvljJSxnzC+rNVdOeLC48+aSabX7PZ0W/aPVw+6awz45ccj4/T6G2ePfX1xjfXLplAnKB1NJmkokxssTa4PJ3XeIaReHhccmbnz7qP59/Y8XU75rM6ausa46QXH96nmt8no14v1jtyfjfPmnnyyyZJOUpdWybAN2IE+OgAHtbTv+bR1x5k8uFcJLvH8ev4Pq9s3nR66cceKbWRpuk1w/L+H50b4sk8c4zhJxlF8pp8NMx34ddvrXXlzq/Wbwxwc5yUYxXLbfCSPnd2+ssWLHPFt0XObXCyyXCj7pPr368fJ85uO/6vX6THp8jUYpffXy8R+r/wCevxx5HXqZcf8ANj3d3vzX5qrn1GXU5XkzZJ5Jy6ynLlv5JAdz1vOGU+O5gdwPR2vds+3zajxLHJpyhLp8ejPs9JqsWt06y4ZcxfVd0/Rn52etsGvyaXXRxxScM0lCS+fJ/wBMeXjuLj1rx7z5l5IANmQB3HAAAAAAA8wAAAAABAAdGgyQw67Bkm+IwyRk36JM5wM4uDAO4HIABgAAgAAAAAAAAAAAAAAf/9k=" },
      { ref: "mem_1a77", kind: "image", title: "Beach, Outer Banks", thumbnail_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wAARCACAAIADASIAAhEBAxEB/8QAGgABAQADAQEAAAAAAAAAAAAAAAIBAwQGBf/EADQQAAICAgACBQgLAQAAAAAAAAARAQIDBBIhBQYxQVEVMlRxgZGToRMiIyQ1QmFzscHR8P/EABgBAQEBAQEAAAAAAAAAAAAAAAABAgMF/8QAFxEBAQEBAAAAAAAAAAAAAAAAABEBAv/aAAwDAQACEQMRAD8A6kEbEEelXlxCCLQQpGtBGxBCkQjCNi5BCrEIItBCka0EbEEKkQgi0EKRrQRsQ4RSLQRaCMV0iEEWghSIQ4S0EKRCCLQQpEIItBCkQgi0EKRCCLQQpEIItBCkWgjYjEVOdbiEEbEEKRrQRaCFIhBGxGEKRCCLQQpEIItBCkQgjYghSNaCLQQpFoyi0Ec63EIwjYghSIQRaCFIhBFoIUiEEWghSI4Qi+EIUiEEWghSIQRaCFItBFqCJvWLRWbRxTDiPE510gginAhCpEoItBCkQuQRfCEKsQgi5Rz5tzX17RGXNSkz3TPPwFSNqHCZpet6xatotWYcTHeZ5CkSgi+QQpEIItBCkePy9Zdy+Oa1jFSZ/NWsuPfJ8nJnyZbze97WtPba0uTWDcadXlHc9KzfEk26vS+5qqKZrTWF9W3OFHd+nsOAAen1etEKI2cM9nnY5/qf9PraHS+rvTMY7cN4lRS6iZ9XieCKpe1LRalpraJcTEpSTecHvt/pLW0KPLd27qV52n2Hzb9Z9WKzwYs0yuUTERE/M8pky3zXm+S9r2ntm0uSCZyPsb3WDa2XXFP0FPCk8/f/AIj5E2me8wDUg34tzYw1muLNkpVtVtMF+Udz0rP8STlAH1MPT2/j4Xm4q1XK1Yl+ue0+/q9YtTLiic1pw3fmzE2+cQeMBNzNHr97rHr48X3X7a8+MTEV9bOXo7rFmy58eHNireb2rWLVlT4Of+g80zq6M/Etb92v8wJg5QAaAAAAAAAAAAAYMgAAB3ABHIAAAAHcAAAAAAAAAAAMGQMGQAAAA//Z" },
      { ref: "mem_2c40", kind: "image", title: "Cabin trail, October", thumbnail_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wAARCACAAIADASIAAhEBAxEB/8QAGgABAQADAQEAAAAAAAAAAAAAAAIBAwUGBP/EACwQAAICAQMCBQEJAAAAAAAAAAARAQIDBAUhEkETMTJRYYEVIjRCU2JyobH/xAAYAQEBAQEBAAAAAAAAAAAAAAAAAgMBBP/EABwRAQEBAQACAwAAAAAAAAAAAAARAQIDQRIhMf/aAAwDAQACEQMRAD8A80gjYgjOpiEEWghXIhGEbEEKRCCLQQpEIwjYghSIQRaC4FIhBcFoIUiEEWuQhSLQRsQRFXGtDpNiCFI1oI2IwhSIQRaMoUjWgjYjCFIhBFoyhSNaCLQQpEIItGUKRaCLXwERVxCCLQQpEIIuICFIhBFoIUiEEWh08CkQjCNiCFIhCILQQpEIItBCkWEedjV54mJjLfj9zPs0u6X64rmU172iOTu8bhnWOujCLjkyjOrjWjK5LRiYQrkQgjm63c4h0wS5iVN+30Pj+0dT+p/UGmcbqd6zHeQRx9PuuSsrNEXie/lMHQpuGmso8RTPaYng5vO47m5r6OkIuIZlEVUQjCNiJvatK9VpisR3kUiUEc7Ju9a3mKY+qseUzKZqw7nmy5sdJikRNoiVHyX8OkfLHMHIB6GTrbVrp6q4MkuJ4rM9vg7UQzyESd3addOavhZbffjymfOxh5OPeNeOvWujMcHG3TXzNrYMUzERxaff4Po3HcqVx2x4L9V546q9vqcKeZHj496d9esY7gA3ZAaAA7W06yLRXT39Uemff4OsjyOO8471tWVMS4k9Lptdhyaelr5aVtMc1m0Ryefycz7xtx161s1GamnxTfJKiO3uef1utvqrR+WkeVYL3PWzqc01pafCr6Y9/k+Evjifep66v4G7Sfi8X84/00l4b+FmpdPptEr3NN/EYgAHXAAAPMAAAAAAAAyzAAAAAJAASAAA7gAAAAAAAAAAAAAAAAAAAAAAACQAAAADuAAAAAAAAAP/2Q==" },
      { ref: "mem_3b19", kind: "image", title: "Skyline from the roof", thumbnail_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wAARCACAAIADASIAAhEBAxEB/8QAGgABAQEBAQEBAAAAAAAAAAAAAAECAwUEB//EACkQAQADAAEEAAUDBQAAAAAAAAABAhEDBBIhMRMyQVFxFGGBIjORobH/xAAXAQEBAQEAAAAAAAAAAAAAAAAAAQID/8QAGBEBAQEBAQAAAAAAAAAAAAAAAAERIVH/2gAMAwEAAhEDEQA/APz4xrDHdlnDGsM8gzhjRgM4Y1iAmGNYYDJMNYYDJjWGAzhjWJgNYuLi4NM4Y1hgjOGNYmAmJjZgrC4uLgM4mN4YDOGNYYDOEwuGA1i40YKzhjWICYY1hgMYuNYYDOGLi4DC41iYCYY1iYCYYuLgLhjWx9wVnFxcXAZwxcUGMXGsTATDFAZxc8tYYDOJjWKDGLjWGA86bTadmZmVpeaW2JYGGXpcd4vWJq1jzuPktxztZx6HDeOTji0fzH2al1qXWpgXDFVl8nL1Fu/KTkR/tvq+XP6I/l8bNrNrc8t5nZtLtxdTni/+XzCamvTraLxtZ2Fx53HyTx3iYelS0XrEx6lqXWpdTFxcJhVc+S0UrsuFep7rREUzZ+7jz8nxOSftHpni/u1/MM6zrADLI7dNy/Cv5+Wfbiqq9dz5+SOKk2n36j8uPT9TWOGY5J819fvD5+o5vjX31EemreN28crWm1pmfcoDLAH7HlEH09Hydt+yfVv+vmWJmJ2PCxZXr4+fq+SKcfb47rOf66e35PP5fLe03tM2nZW1q3xlqs9tomPpOojLACqCAih9Q9iKgAKgAAAAKAKgCoIACoAp9BUEFAEAUD6ggqAD/9k=" },
      { ref: "mem_4e83", kind: "image", title: "Ridge above the lake", thumbnail_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wAARCACAAIADASIAAhEBAxEB/8QAGwABAQACAwEAAAAAAAAAAAAAAAIEBgEDBQf/xAAyEAACAgEDAgMGAwkAAAAAAAAAAQIRAwQFIRIxBkFREyIycZGxYqHBFCVCc4GT0eHw/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAECBP/EABURAQEAAAAAAAAAAAAAAAAAAAAR/9oADAMBAAIRAxEAPwDvoUX0ijvriiK4FF0OkUiKFF0KFIihRdChSIoUXQoUiKFF0KFIihRdChSIoUXQoUi6FF0KMVqIoUX08ihSIoUXQoUiKFF0KFIihRdChSIoUXQoUiKFF0KFEUKLSFCkXQouhRitx10c1yXQoUiOkUXQoUiKFF0KFIihRdChSIoUXQoUiKFF0KFIihRdChSLo4PB3Dfu8NJ/ca+yZhYt61UM0Zzn1xXDjSSaMVuNsoUYug1+HW404SSnXMG+V/ozUKkRQouhQpEUKLo4fApE0K5MTNuujw5JQnmSlHh0m/sYsfEGkcknHKrfdpcfmKR6tCjF025aXU5FjxZVKfeqav6mbVikRQouhQpEUKLomTjFctLmuRSPn4AMtqhOUJKUW01ymn2Nn2Lc3qY+wzyXtIr3W3zJf5NWKxzlCalFtNO00+wH0OhRhbRuEdfpup1HJF1OP6/Iz64JUiHwuTWt53lyk8Okm1FP3skX3+T9DJ8Sbh7PGtNinU5fHT7L0/r/AN3NY8yqW2zgACoTlCSlFtNO013Rtuybl+24nDJXtoLn8S9TUDu02eem1EMsHUou0Bv9CjF23X4tfgU4cSXxQb5izNrglSMfU5o6fBPLkdRgrZqy3LNrdzwdbrGssXGC7Ln8zN8T634dLjl+KdP6L9foeJtz/eGn/mR+5VYwAAAADM2zWPRa3HlTfSnUkvNeZt+s3HDptAtRzOM0uhL+K1a+RolnZPPkyY4Y5SbhjTUV6W7JBWqzz1OonlyP3pu2dIBQAAAAAZm3bhl0Go68fMX8UH2kj3s/iPDLQSeJSjnapRa7Ou9+hqoEFTnLJNyk25N22+7JVoAAAAAAAAAADk4AAAAAAAAADyAoAAACAAAAAAAAAQAeQAAAAAAAP//Z" },
      { ref: "mem_5d52", kind: "image", title: "First snow, back field", thumbnail_url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wAARCACAAIADASIAAhEBAxEB/8QAGgABAAMBAQEAAAAAAAAAAAAAAAECAwUGBP/EADEQAAICAQIEAgcJAQAAAAAAAAARAQIDBBIFITFBBtEjMlFxgZGhFSIkQlJTYeHw8f/EABcBAQEBAQAAAAAAAAAAAAAAAAABAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwD7UF7TRBHSxZrkEaIICiIRoggM0EaIbQM0EaIbQM1zCNENoGaCNEEBRERBoggLoI02hEVmiUXQQGaCNEEBmgjRBAZoI0QQGaCNEEBmgjRBAZ7QjRBAXRK5l0NpBREI0QQFEEXQ2gZolF0EBmgjRDaBmhtNEEBmgjRBAZoI0QQGiCLoIiqIIuggKIIuggKIIuggKIhGiEQBRBF0EBRBF0EBREI0QQGi5jaXQRFUQ2l0EBRDaXQQFFzCL7QgKIRUuggKIbS6CYGaJRdBAUQRdBAcvUce02OFii2W38Qo+vkcjJxrWWy7q5Ir221rC+pzQB2I8Qan9vF8p8z7NN4gx3UZ8c0nlG6vOP8AfM84APdYM+LPj34rxes94NYiOx4TFnyYbbsd7UlJ1lHW4PxfJTURj1OSbY7/AJrz6s+QHpkUvatKza0xERDmZ7HN4nxrHpommBZMsSpfSp5/V8S1OqcZMk7Jn1Y5R/fxA6/EeOVpM49KrWjlN56fA5+HjerxVU2rk6RG+OhzQB1vt/VbonbiXsU+Z92LxDhmvpMV6y+lVPkebAHuNJqsOrxxfFaJ5c47x7z6EeEwajLp8kXxXmlo7xJ6TRcfwXx/ifRXj2RMxIHXRhn1OLBalb2+9ktFaxHWZk5et8QY6Oulrvn9VoUfL/hxtNnvn4phyZLTa1stZmZ98AfGCCQIJI7gAT0AAdSCQAIJIAkAgCQQAJHuIJAAdwAIJAAAgASCAJIJIAkEEgAAABBIH//Z" },
    ];

    // The two strings the asset screens actually print. Everything else about the
    // asset — including its real id — is left exactly as the server returned it.
    const PINNED_CREATED_AT = "2026-06-15T14:58:12Z"; // -> "6/15/2026, 2:58:12 PM"
    const PINNED_SHARE_URL = "https://photo-time-machine.local/view/a7989c36";
    const pinAsset = (a) => ({
      ...a,
      created_at: PINNED_CREATED_AT,
      share_url: PINNED_SHARE_URL,
    });

    // `/api/v1/assets` and `/api/v1/assets/:id` only — NOT `/file` or `/thumbnail`,
    // which are binary and must stream through untouched.
    const ASSET_LIST_RE = /\/api\/v1\/assets\/?(?:\?.*)?$/;
    const ASSET_ONE_RE = /\/api\/v1\/assets\/[^/?#]+\/?(?:\?.*)?$/;

    // A job pinned to `running` so the create-processing beat holds still. Without
    // this the CPU Preview engine finishes before the client's first 1.5 s poll and
    // the app navigates to Explore mid-shutter.
    const RUNNING_JOB = {
      job_id: "job_9f4c1e20",
      owner: "local-dev",
      status: "running",
      engine: "preview",
      message: "running preview",
      error: null,
      asset_id: null,
    };

    await context.route("**/api/v1/**", async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (method === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "*",
          },
          body: "",
        });
      }
      if (/\/api\/v1\/engines\b/.test(url)) return json(route, { engines: ENGINES });
      if (/\/api\/v1\/memory\/media\b/.test(url)) return json(route, { media: MEMORY_MEDIA });
      if (/\/api\/v1\/jobs\b/.test(url)) return json(route, RUNNING_JOB);

      // Asset reads are REWRITTEN, not faked: ask the real server, then pin only the
      // two volatile strings (hazard 4). A non-2xx passes straight through so a
      // genuinely broken stage still fails loudly instead of rendering a fixture.
      if (ASSET_LIST_RE.test(url)) {
        const res = await route.fetch();
        if (!res.ok()) return route.fulfill({ response: res });
        const body = await res.json();
        return json(route, { assets: (body.assets ?? []).map(pinAsset) });
      }
      if (ASSET_ONE_RE.test(url)) {
        const res = await route.fetch();
        if (!res.ok()) return route.fulfill({ response: res });
        return json(route, pinAsset(await res.json()));
      }

      // /assets/:id/file and /assets/:id/thumbnail are binary — real server, untouched.
      return route.continue();
    });
  },
};
