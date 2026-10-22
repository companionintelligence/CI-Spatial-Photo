/** @type {import('tailwindcss').Config} */

// October 2026 restyle: the Companion site system (ci.computer, docs.ci.computer). The app is dark only.
//   - grounds, panels and ink are the @companionintelligence/tokens dark values (background #041620,
//     card #0c323c, popover #143e48, foreground #e8f2f4, muted-foreground #a3babf); the gray ramp the
//     components already use is remapped onto them, with hairlines at 12 to 14 percent of the ink;
//   - `primary` is the logo's three rings: 600 the deep ring #066c80 (flat button fill), 500 that fill
//     16 percent toward white (hover), 400 and 200 the light ring (labels, links on the dark ground);
//   - `amber` is remapped onto the ring colours (no orange or heat colour); red stays the status red;
//   - `cta` is the accent green, for the one highlighted call to action;
//   - radii 3px (controls) and 5px (cards); no shadows.
// Literal values here, because a Tailwind config cannot read the tokens' CSS variables for opacity
// modifiers; they equal the tokens, and tokens 1.3.0 (CI-Common PR #413) carries the same names.
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    borderRadius: {
      none: "0px",
      sm: "3px",
      DEFAULT: "3px",
      md: "3px",
      lg: "5px",
      xl: "5px",
      "2xl": "5px",
      "3xl": "5px",
      full: "9999px",
    },
    boxShadow: {
      sm: "none",
      DEFAULT: "none",
      md: "none",
      lg: "none",
      xl: "none",
      "2xl": "none",
      inner: "none",
      none: "none",
    },
    extend: {
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
          200: "#3ae7ba", // light ring: labels and links on the dark ground
          400: "#3ae7ba", // light ring: borders, the active tab underline
          500: "#2e8494", // deep ring 16 percent toward white: hover
          600: "#066c80", // deep ring: the flat primary fill
          700: "#055a6a", // pressed
          900: "#0c323c", // disabled fill (the card colour)
          DEFAULT: "#066c80",
        },
        cta: { DEFAULT: "#069b5b", hover: "#05824c" },
        ground: "#041620",
        surface: "#0c323c",
        gray: {
          50: "#f3f9fa",
          100: "#e8f2f4", // ink
          200: "#d2e0e3",
          300: "#bccdd1",
          400: "#a3babf", // muted ink
          500: "#7d979c",
          600: "#4e6c73", // strong hairline (30 percent ink)
          700: "#2b4d56", // hairline (14 percent ink)
          800: "#143e48", // popover
          900: "#0c323c", // card
          950: "#041620", // ground
        },
        amber: {
          200: "#b9f5e6",
          300: "#3ae7ba",
          400: "#3ae7ba",
          500: "#1fa89e",
        },
      },
    },
  },
  plugins: [],
}
