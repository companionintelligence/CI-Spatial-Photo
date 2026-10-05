/** @type {import('tailwindcss').Config} */

// This repo had no colour of its own. `theme.extend` was empty, `src/index.css`
// is three @tailwind directives, and there is no CSS variable anywhere in the
// tree — so every accent on screen was stock Tailwind `blue-*`, consumed raw at
// fourteen call sites. On camera that put this product in system blue on pure
// black while the other eleven CI films are phthalo on #041620: the film shared
// no colour with the fleet, including with its own titles, which video-kit
// paints in #0A6358 / #ABD4D8 / Manrope.
//
// Declared as SEMANTIC names — `primary`, `ground`, `surface` — rather than by
// overriding the stock `blue` ramp. Remapping `blue` would have been two lines
// and would have left `bg-blue-600` meaning phthalo, which is a trap for
// whoever edits this next.
//
// Values are the canonical CI palette, matching what video-kit already paints
// the film's own chrome with (packages/video-kit/src/brand.mjs). 600/DEFAULT is
// phthalo (video-kit's `brandTeal`) — the pre-v0.3.1 #0F717A survives only as
// --teal-600, a ramp rung, not the brand primary anymore. 200/900 are
// --teal-200/--teal-900, unchanged by that rework, so they keep their original
// hex. 400/500/700 have no named canon token (they're this repo's own
// border/hover/pressed shades) — re-derived by keeping each step's original
// HSL lightness *relative to the old 600* and rotating hue+saturation onto the
// new phthalo anchor, so the ramp stays a coherent monochrome progression
// instead of the new 600 sitting oddly between old-hue neighbours.
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      // Manrope is the canonical CI sans (CI-Common tokens `--font-sans`), self-hosted by
      // src/index.css. The system stack behind it is Tailwind's own default, so a visitor
      // whose font has not loaded yet — or who blocks it — gets what this app used to
      // render everywhere rather than a serif.
      fontFamily: {
        sans: [
          "Manrope",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        primary: {
          200: "#ABD4D8", // teal-200 — text on a fill, disabled label (unchanged ramp)
          400: "#14C7B1", // borders, the active tab underline
          500: "#0D8475", // hover
          600: "#0A6358", // phthalo — the primary fill (was teal-600 #0F717A)
          700: "#084E45", // pressed
          900: "#0A222E", // teal-900 — disabled fill (unchanged ramp)
          DEFAULT: "#0A6358",
        },
        // #041620 is the canon ground, and brand.mjs comments it "never pure
        // black" for exactly the reason this film demonstrated.
        ground: "#041620",
        // video-kit's brand.mjs calls this exact trap out by name: #0A222E is
        // canon, but as of v0.3.1 it's the LIGHT theme's --foreground / the
        // ramp's --teal-900, not a dark surface fill. `surface` isn't consumed
        // by any Tailwind class anywhere in this app today, so this is a
        // preemptive fix rather than a visible one — pointed at --secondary
        // (#073038), the canon dark subtle-fill token, so it's correct if a
        // future screen starts using it.
        surface: "#073038",
      },
    },
  },
  plugins: [],
}
