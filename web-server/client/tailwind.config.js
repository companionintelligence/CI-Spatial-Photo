/** @type {import('tailwindcss').Config} */

// This repo had no colour of its own. `theme.extend` was empty, `src/index.css`
// is three @tailwind directives, and there is no CSS variable anywhere in the
// tree — so every accent on screen was stock Tailwind `blue-*`, consumed raw at
// fourteen call sites. On camera that put this product in system blue on pure
// black while the other eleven CI films are teal on #041620: the film shared no
// colour with the fleet, including with its own titles, which video-kit paints
// in #0F717A / #ABD4D8 / Montserrat.
//
// Declared as SEMANTIC names — `primary`, `ground`, `surface` — rather than by
// overriding the stock `blue` ramp. Remapping `blue` would have been two lines
// and would have left `bg-blue-600` meaning teal, which is a trap for whoever
// edits this next.
//
// Values are the canonical CI teal, matching what video-kit already paints the
// film's own chrome with (packages/video-kit/src/brand.mjs).
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          200: "#ABD4D8", // tealLight — text on a teal fill, disabled label
          400: "#58B6BC", // borders, the active tab underline
          500: "#129FA4", // hover
          600: "#0F717A", // brandTeal — the primary fill
          700: "#0B5A61", // pressed
          900: "#0A222E", // disabled fill
          DEFAULT: "#0F717A",
        },
        // #041620 is the canon ground, and brand.mjs comments it "never pure
        // black" for exactly the reason this film demonstrated.
        ground: "#041620",
        surface: "#0A222E",
      },
    },
  },
  plugins: [],
}
