# AR and the calibrated magic window

Two different things in this app are called "XR", and they are not the same feature:

| Feature | What it is | Where it runs | Toggle |
| --- | --- | --- | --- |
| **Magic window** | The screen behaves like a pane of glass; the *projection* becomes asymmetric as you move your head. Off-axis perspective driven by the webcam. | Anywhere with `getUserMedia` — including **iOS** | The eye button in the top bar |
| **Immersive AR** | The memory stands on your floor and you walk around it. WebXR `immersive-ar`. | Android Chrome, Quest browser. **Never iOS.** | "View in your room", bottom-right of the viewer |

They share almost nothing but a word. This document covers both, plus the display calibration
that makes the first one physically true.

---

## 1. Immersive AR

### Why WebXR and not `<model-viewer>`

`MeshViewer.tsx` already gets native mobile AR for free — `<model-viewer ar>` hands a GLB to
Scene Viewer on Android and a USDZ to Quick Look on iOS. That path is **not available to the
splat viewer**, and the reason is upstream of the client: every engine in this app declares
`output_kind: "splat"`. There is no mesh, so there is nothing for Scene Viewer or Quick Look to
open, and a USDZ conversion path would have to invent geometry that no engine produces. So the
splat viewer draws AR itself, through WebXR, with the same Three.js + Spark renderer it already
has.

### iOS

Safari implements neither `immersive-ar` nor `immersive-vr`, and every third-party browser on
iOS is Safari's engine wearing a different icon, so there is no in-browser AR on an iPhone or
iPad at all. That is a large share of the people who will open a shared memory link, and
"AR unavailable" with no explanation reads as a bug in the app.

The viewer therefore renders, in place of the button, a disclosure that says what is actually
true and points at the thing that *does* work on an iPhone:

> AR is not available on iPhone or iPad → Safari on iPhone and iPad does not implement WebXR …
> Turn on XR for the head-tracked window instead: it uses the front camera and works here.

The note appears **only** for `reason === 'ios-no-webxr'`. A desktop Chrome reports
`mode-unsupported` and gets nothing — that user is not waiting for an AR button and does not
need to be told their laptop is not a phone.

> One nuance worth knowing: the UA sniff only ever *explains a measured negative*. If
> `navigator.xr` exists the real query wins regardless of the user agent, so visionOS Safari and
> the WebXR Viewer app are reported as supported rather than talked out of it.

### The rule that keeps the product video green

`video/storyboard.json` drives this app with Playwright in headless Chromium: no WebXR, no
webcam, XR off. **No AR control may ever appear in a capture.**

`isSessionSupported` is asynchronous, so the only construction that cannot flash a control into
a frame is: default hidden, render on a confirmed `true`.

```tsx
const [caps, setCaps] = useState<XrCapabilities | null>(null);   // null = unknown → render nothing
useEffect(() => {
  let live = true;
  detectXrCapabilities().then((c) => { if (live) setCaps(c); });  // cannot reject
  return () => { live = false; };
}, []);

{assetReady && arPhase === 'off' && caps?.ar.supported && <button title="View in AR">…</button>}
```

`utils/webxrSession.ts` deliberately exposes **no synchronous "probably supported" accessor** to
misuse, never touches `navigator.xr` at module-evaluation time, and only ever reports
`supported: true` after `isSessionSupported()` returned exactly `true` — a sloppy polyfill
returning `1` does not count. `SplatViewer.test.tsx` asserts the absent cases and the present
case in one run, so a negative that starts passing vacuously fails alongside the positive.

### Session lifecycle

```mermaid
sequenceDiagram
    participant U as User
    participant V as SplatViewer
    participant S as utils/webxrSession
    participant T as three WebXRManager

    U->>V: tap "View in your room"
    V->>S: requestXrSession({ mode, domOverlayRoot })
    Note over V,S: first statement in the handler — an awaited<br/>support re-check would lose user activation
    S-->>V: XrSessionHandle
    V->>S: resolveReferenceSpace(session)  → local-floor | local | viewer
    V->>T: xr.setReferenceSpaceType(type); xr.setSession(session)
    V->>V: snapshot camera + scene, hide grid, background = null, clearAlpha 0
    V->>S: session.requestHitTestSource({ space: viewer })
    loop every XR frame
      T-->>V: animate(time, frame)
      V->>V: reticle ← frame.getHitTestResults(source)[0]
    end
    U->>V: tap (XR `select`)
    V->>V: placementFromHitPose → applyPlacement(group)
    U->>V: tap "Exit AR"  /  removes headset  /  Android back
    S-->>V: handle.onEnd → restoreFromAr()
```

Five things in that flow are load-bearing and easy to get wrong:

1. **`requestXrSession` is the first statement in the click handler.** Immersive session requests
   need transient user activation, and activation expires across awaits. An
   `isSessionSupported` round trip between the click and the request is how "Enter AR" becomes a
   button that works on a fast phone and silently fails on a slow one. Support is already known:
   the control does not exist until the probe confirmed it.

2. **The reference space is resolved before three sees the session.** three's `setSession`
   awaits `session.requestReferenceSpace('local-floor')` and rejects if it is refused — but
   `local-floor` is only an *optional* feature, precisely so a phone that has not found the floor
   yet still gets a session. `resolveReferenceSpace` walks `local-floor → local → viewer` and the
   answer is handed to `xr.setReferenceSpaceType()`, which turns a hard failure back into the
   soft one it was meant to be.

3. **The DOM overlay root is mounted unconditionally**, empty and `pointer-events-none`, from the
   first render. `requestSession` reads it at click time; a root created on demand — or one
   behind `{arPhase !== 'off' && …}` — is `null` at exactly the moment it is needed, and the
   session then opens with no Exit button and no way out but the system back gesture.

4. **Leaving AR restores a snapshot, it does not "put the session down".** three's WebXRManager
   *overwrites* the camera every frame: `matrix`, `position`, `quaternion`, `projectionMatrix`,
   and also `fov`, `aspect` and `zoom`. `handleResize` never rebuilds `fov` on the
   non-intrinsics path — the common one — so it has to be snapshotted explicitly. This mirrors
   the magic window's existing anchor/`giveBack` pattern and ends in the same
   `applyProjectionRef.current?.()` call, so there is one camera-exit path and not two.

5. **`onEnd` fires at most once, and it fires for reasons the app never initiated** — headset
   removed, Android back gesture, OS pre-emption. The restore is registered before anything can
   fail, is idempotent, and is also called directly on the failure path, because a session that
   died between being granted and being wired up has already spent its single notification.

### Spark's WebXR ordering

Two rules, both from Spark itself:

- **`preUpdate` must stay `false`.** From `SparkRendererOptions`: *"Controls whether to update
  the Gsplats before or after rendering. For WebXR this must be false in order to complete
  rendering as soon as possible."* False is the default; the viewer sets it explicitly so it is
  a decision rather than an accident. Flipping it stalls the XR frame behind a full re-sort.

- **Frames must go through `renderer.setAnimationLoop`.** Spark's `onBeforeRender` branches on
  `renderer.xr.isPresenting` and takes its sort viewpoint from `renderer.xr.getCamera().cameras`
  (averaged across views) instead of from the app camera. It only gets the chance if the splats
  are drawn inside the session's own frame callback. Driving the loop with a bare
  `requestAnimationFrame` would sort every splat against a camera three overwrites but does not
  drive — the whole memory renders back to front.

`setAnimationLoop` is also how the viewer gets the `XRFrame` at all: it is the second argument
of the callback, and hit testing has no other source for it. three stops its page-level loop on
`sessionstart` and restarts it on `sessionend`, so one registration covers both modes.

### Placement and gestures

All of the arithmetic lives in `utils/arPlacement.ts`; the viewer only wires it up.

| Interaction | Input | Function |
| --- | --- | --- |
| Place | XR `select` (a tap on the scene) | `placementFromHitPose` → `applyPlacement` |
| Move | one finger on the overlay | `beginDrag` / `updateDrag` |
| Resize + turn | two fingers | `beginTwoFinger` / `updateTwoFinger` |
| Re-place | the **Move** button | back to `scanning`, keeping yaw and scale |

- **The memory is wrapped in a `THREE.Group`**, identity outside AR. It cannot be placed
  directly: `applyPlacement` writes a whole TRS, and the mesh's own TRS already carries the
  CV→GL axis flip that makes the asset the right way up.
- **Placement uses the bounding box's bottom centre** (`assetFrameFromBounds`), so "tap here"
  means "stand it here". Without it the asset's *origin* lands on the tap, which for a depth
  cloud is the median-depth plane — the memory floats, or sits a metre to one side, and it looks
  like the hit test is broken.
- **Arrival scale normalises the asset's units away**, targeting a 1 m largest extent. A Preview
  postcard is ~3.6 units wide for a 16:9 photo; dropped into a metre-based reference space
  unscaled, the user is standing inside it.
- **Placement is by `select`, not by a DOM tap**, because a headset has no DOM overlay and
  therefore no pointer events. The gestures are overlay-only and handheld-only by construction.
- **Tapping an overlay button must not also place the memory.** The control bar cancels
  `beforexrselect`, which suppresses the XR `select` for that touch. Only the bar does — a tap
  anywhere else on the overlay is meant to reach the scene.

### `immersive-vr`: deliberately not shipped

`detectXrCapabilities` probes it (a Quest reports both modes, a tethered PC headset reports only
VR), so the information is there — but no VR entry point is rendered, because it is not
near-free:

- there is no hit test in VR, so nothing decides where the memory goes. The AR flow's entire
  interaction model — reticle, tap, drag on a real surface — has no counterpart.
- at identity the memory sits on the reference-space origin, which is where the user is
  standing. VR would need its own arrival placement (a distance in front of the viewer, a
  synthetic floor, a way to walk it back), plus a background — passthrough is not there to hide
  the fact that the scene is otherwise empty.

That is a second product, not a flag. `AR.md` is the place to record it if it is ever wanted.

### Testing on a device

There is no WebXR in CI and none in jsdom, so everything above is verified by hand. The
practical recipe:

```bash
# WebXR needs a secure context, and http://<lan-ip> is not one.
# Easiest on a tailnet:
tailscale serve --bg 3000            # then open https://<host>.<tailnet>.ts.net on the phone
```

Then, on an Android device with ARCore:

1. Load a memory, confirm **View in your room** appears (it must not appear on a desktop).
2. Enter AR — the room shows through, the grid and the dark background are gone.
3. Point at the floor: the reticle should track a real surface, not the middle distance.
4. Tap: the memory stands on the floor at about a metre tall, facing you, upright.
5. Drag it across the floor — it should stay under your finger at a grazing angle, not slide
   away as it goes further off.
6. Pinch and twist. A there-and-back gesture must return to exactly the starting size.
7. Exit AR, then confirm the orbit view is **exactly** as you left it: same framing, same
   zoom, orbit/zoom/pan working, grid back, background back.
8. Repeat 2–7 with the eye button on beforehand, to check that AR and the magic window hand the
   camera back and forth cleanly.

Chrome's `chrome://inspect` remote devtools work on the AR session, and the WebXR emulator
extension is enough to exercise the entry/exit path on a desktop without a phone.

---

## 2. Display calibration

### The problem

The magic window's parallax was self-consistent but not physical. `mapHeadPoseToEye` assumes
that, at the moment the user pressed **Recentre**, the physical screen subtended exactly the
virtual camera's field of view. Write that assumption out: with the glass `d` world units in
front of the eye and half-height `h = tan(fov/2)·d`, it claims

```
h / d  =  halfHeight_metres / viewingDistance_metres        i.e.  tan(θ_virtual) = tan(θ_physical)
```

which is false for every display that is not the size the assumption implies. A 13" laptop at
60 cm subtends about 16° vertically while a 60° virtual camera claims 60, so the true parallax is
understated by a factor of ~3.6 — and a 27" monitor and that laptop behave identically, which
is wrong by a factor of two between them.

### Why the app has to ask

There is no browser API for physical display size. `devicePixelRatio` is a rendering ratio, not
a physical one, and the CSS `mm` unit is *defined* as 96/25.4 px, i.e. a fiction. So the panel
asks for the one display dimension everyone knows: the diagonal printed on the box.

The chain from there (`utils/screenGeometry.ts`) collapses to something robust:

```
canvas_width_mm  =  monitor_width_mm × (canvas.clientWidth / screen.width)
```

— the monitor's physical width times the *fraction of the screen the canvas covers*. Both
operands of that fraction are CSS pixels, so **browser zoom cancels exactly**, and
`devicePixelRatio` never appears anywhere in the module.

### What calibration changes

Not a gain. `utils/magicWindow.ts` keeps the glass at the size the orbit framing gives it and
moves the **eye**, from `d = f·L` back to `d = f·L·A`, where

```
A  =  tan(fov/2) · calibrationDistance_m / halfHeight_m  =  tan(θ_virtual) / tan(θ_physical)
```

is the ratio the old assumption asserted was 1. The camera pulls back by `A` and the lens
narrows by exactly `1/A`, and the two cancel **at the target plane** — so the memory is framed
identically whether or not a display size has been entered, which is the property that lets
"switching XR on must not re-frame the memory" survive calibration.

The two projection *matrices* are deliberately **not** equal, and must not be forced to be:
calibration is a dolly, so points off the target plane move by ~22% at `A = 2.75`. That
flattening — a longer lens on the same subject — is the visible signature of the calibration
being real, and it is what looking at a small window from a normal viewing distance actually
looks like. `magicWindow.test.ts` asserts the target-plane invariant, asserts the matrices
differ, and asserts the flattening, so nobody later "fixes" the design by forcing equality.

`A` is typically 1.5–4 on a desk display and is clamped to [0.2, 12]; the far plane is widened
by `A` in the same breath, or the subject clips out of the back of the frustum.

### The control

In the XR panel, under the parallax slider:

| Element | Behaviour |
| --- | --- |
| **Screen size** field | The panel diagonal in inches. Committed as you type. Persisted in `localStorage` under `ptm:display-diagonal-inches` |
| **calibrated 1:1 / relative** badge | Which projection is actually live. Green when the parallax matches real head movement one to one |
| Validation | Outside 4–150 inches the entry is refused with an inline message *and the stored value is cleared*, so the badge can never claim a calibration the projection is not using. An empty field is not an error, just an uncalibrated window |

The value is shared through a module-level store in `screenGeometry.ts` rather than through
props: the control that sets it is in `TopBar`, the code that reads it is in `SplatViewer`'s
render loop, and their only common ancestor is `App.tsx` — which owns neither piece of state and
should not grow a viewer setting. It is deliberately not a React context either; the viewer
reads it in `handleResize`, not during render.

### Known, bounded errors

Named because each one degrades gracefully and none is worth a worse design:

- **Firefox at non-100% zoom.** Chromium reports `screen.width` in the same zoomed CSS pixels it
  reports element sizes in, so the zoom cancels. Firefox reports it unzoomed, so a zoomed Firefox
  user is off by exactly the zoom factor.
- **Two monitors.** `window.screen` reports the screen the window is currently on, so dragging
  the browser from a laptop panel to an external display silently re-derives millimetres per
  pixel from the wrong diagonal. Fixing it needs the Window Management API and per-display
  settings. The panel copy says "assumes this browser window is on the display you measured".
- **A browser that reports no screen size** (jsdom, and some locked-down environments) leaves
  the window relative no matter what is stored, and the badge says so.
- **The webcam's assumed field of view** still sets the absolute scale of the distance estimate
  in `headPose.ts`. Recentre divides it out.

---

## Files

| File | Role |
| --- | --- |
| `utils/webxrSession.ts` | Capability detection, feature negotiation, one-session-at-a-time lifecycle. Imports nothing, so it is safe in the always-loaded shell |
| `utils/arPlacement.ts` | Hit pose → placement, arrival scale, composition, gestures. Imports three — **lazy viewer chunk only** |
| `utils/screenGeometry.ts` | Diagonal → canvas rectangle in metres, plus the persisted store |
| `utils/magicWindow.ts` | Off-axis projection and the calibration dolly |
| `components/SplatViewer.tsx` | The only component that wires any of it to a renderer |
| `components/TopBar.tsx` | The calibration control |

> **Bundle note.** `App.tsx` code-splits the viewers so that three, Spark and MediaPipe stay out
> of `main.js` (an 82% reduction that no test can catch the loss of). `webxrSession.ts` is
> import-free and may be used anywhere; `arPlacement.ts` and `magicWindow.ts` import three and
> must stay reachable only from the lazy viewer chunk.
