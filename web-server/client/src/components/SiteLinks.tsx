import React from 'react';
import {
  BRAND_NAME,
  BUY_BLURB,
  BUY_LABEL,
  BUY_URL,
  DOCS_URL,
  DOWNLOAD_BLURB,
  DOWNLOAD_LABEL,
  DOWNLOAD_URL,
  SITE_URL,
  TAGLINE,
} from '../siteLinks';

/*
  The links back out to Companion Intelligence: the logo in the header, the Buy and
  Download callouts, and the footer. Destinations and wording live in `../siteLinks`;
  this file is only how they look.

  All of them are real <a href> elements that navigate in the SAME tab. This page is a
  visitor's route into the rest of the product, not a popup over it, so none opens a new
  window — which also means none needs `rel="noopener"`. Anything added here later that
  does set `target="_blank"` must bring `rel="noopener"` with it.

  Every link is keyboard-reachable and carries the one shared focus ring below. The ring is
  `focus-visible`, so a mouse click does not leave a halo on a button the pointer just
  used, but Tab always shows where focus is — including against the busy splat behind the
  HUD, which is why it is an outline (drawn outside the box, 2px, a colour that holds
  against #041620) and not a border colour that would vanish into it.
*/
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400';

/**
 * `pointer-events` is INHERITED, and the overlay these links live in (App.tsx) is
 * `pointer-events-none` so the empty space still orbits the model behind it. Anything in
 * that overlay that has to be clicked re-enables pointer events itself; the callouts
 * forgot to, in the empty-state hero, and rendered as buttons that took focus and a Tab
 * ring but swallowed every mouse click (the pointer fell through to the 3D scene). The
 * callouts therefore claim their own events wherever they are placed, rather than relying
 * on whichever ancestor they happen to sit under — `SiteLinks.test.tsx` pins it.
 */
const INTERACTIVE = 'pointer-events-auto';

/** Filled phthalo: white on #0A6358 is 7.1:1, and 4.6:1 on the hover fill. */
const PRIMARY_LINK = `inline-flex items-center justify-center rounded bg-primary-600 px-3 py-2 text-center text-sm font-medium leading-tight text-white transition-colors hover:bg-primary-500 ${FOCUS}`;

/** The quieter sibling: same size so the pair reads as a pair, no fill. */
const SECONDARY_LINK = `inline-flex items-center justify-center rounded border border-gray-600 bg-gray-800 px-3 py-2 text-center text-sm font-medium leading-tight text-gray-100 transition-colors hover:border-gray-500 hover:bg-gray-700 ${FOCUS}`;

/**
 * The Companion Intelligence logo, linking to the main site.
 *
 * The CI-Common lockup (mark + wordmark, light-on-dark), which is the brand's own file
 * rather than a re-typeset name. The image carries no `alt` of its own: the link's
 * accessible name is the aria-label, so a screen reader hears "Companion Intelligence
 * home, link" once instead of the name twice.
 *
 * Width and height are attributes as well as classes so the box is reserved before the
 * SVG arrives — the header does not move when the logo loads.
 */
export const BrandLink: React.FC = () => (
  <a
    href={SITE_URL}
    aria-label={`${BRAND_NAME} home`}
    title={`${BRAND_NAME} — ci.computer`}
    className={`${INTERACTIVE} inline-flex w-fit rounded ${FOCUS}`}
  >
    <img
      src={`${process.env.PUBLIC_URL}/ci-lockup.svg`}
      alt=""
      width={88}
      height={24}
      draggable={false}
      className="h-6 w-auto sm:h-7"
    />
  </a>
);

interface CalloutsProps {
  /**
   * `card` sits inside the 448px first-run card; `hero` sits under the empty-state
   * steps. Only spacing differs. The blurbs drop out below `sm` in both: on a 360x640
   * phone the card has to fit the address field, the presets and a Connect button, and
   * the two buttons are what matters there — the footer repeats them, always on screen.
   */
  variant?: 'card' | 'hero';
}

/**
 * "Buy Companion Core" and "Download Companion", side by side, under the brand tagline.
 *
 * Rendered where a visitor with no server yet is already looking — the first-run card
 * and the empty-state hero — rather than only in the footer, because a footer is where a
 * purchase link goes to be ignored.
 */
export const CompanionCallouts: React.FC<CalloutsProps> = ({ variant = 'card' }) => (
  <section
    aria-label={BRAND_NAME}
    className={
      variant === 'hero'
        ? `${INTERACTIVE} mt-8 hidden max-w-md border-t border-gray-800 pt-5 text-left sm:block`
        : INTERACTIVE
    }
  >
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-200">{TAGLINE}</p>
    <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
      <a href={BUY_URL} className={PRIMARY_LINK}>
        {BUY_LABEL}
      </a>
      <a href={DOWNLOAD_URL} className={SECONDARY_LINK}>
        {DOWNLOAD_LABEL}
      </a>
      <p className="hidden text-xs leading-snug text-gray-400 sm:block">{BUY_BLURB}</p>
      <p className="hidden text-xs leading-snug text-gray-400 sm:block">{DOWNLOAD_BLURB}</p>
    </div>
  </section>
);

const FOOTER_LINK = `rounded px-2 py-1 text-gray-300 underline-offset-2 transition-colors hover:text-white hover:underline ${FOCUS}`;

/**
 * Whether Google Analytics is on this build. The tag is injected at build time only when
 * a measurement ID was supplied (scripts/postbuild.mjs), and its init script runs before
 * React, so `dataLayer` existing is exactly "analytics is on" — with no flag to carry
 * from the build into the bundle, and nothing to disagree with what the page really does.
 */
function analyticsOn(): boolean {
  try {
    return typeof window !== 'undefined' && Array.isArray((window as { dataLayer?: unknown }).dataLayer);
  } catch {
    return false;
  }
}

/**
 * The page footer.
 *
 * It sits in the overlay's flex column, so it takes its own row at the bottom of the
 * viewport rather than floating over the splat's corners — the splat status pill is
 * bottom-left and the AR controls bottom-right, and a footer laid over either would
 * cover a control. The wrapper is `pointer-events-none` and only the link bar re-enables
 * them, so the empty space beside the bar still orbits the model.
 *
 * Present in every state (first run, empty, viewing a memory): it is the one place the
 * way back to ci.computer, the docs and the Buy and Download links are always on screen.
 */
export const SiteFooter: React.FC = () => (
  <footer className="pointer-events-none px-3 pb-3 pt-1 sm:px-4">
    <nav
      aria-label={`${BRAND_NAME} links`}
      className="pointer-events-auto mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-x-1 gap-y-1 rounded-xl border border-gray-800 bg-ground/85 px-2 py-1.5 text-xs backdrop-blur"
    >
      <a href={SITE_URL} className={FOOTER_LINK}>
        {BRAND_NAME}
      </a>
      <a href={DOCS_URL} className={FOOTER_LINK}>
        Docs
      </a>
      {/* Buy, then Download: the same order as the callouts, so the pair never swaps. */}
      <a
        href={BUY_URL}
        className={`rounded bg-primary-600 px-2.5 py-1 font-medium text-white transition-colors hover:bg-primary-500 ${FOCUS}`}
      >
        {BUY_LABEL}
      </a>
      <a
        href={DOWNLOAD_URL}
        className={`rounded border border-gray-600 px-2.5 py-1 font-medium text-gray-100 transition-colors hover:border-gray-500 hover:bg-gray-800 ${FOCUS}`}
      >
        {DOWNLOAD_LABEL}
      </a>
    </nav>
    {analyticsOn() && (
      <p className="mx-auto mt-1 max-w-md text-center text-[11px] leading-snug text-gray-400">
        Page views are counted with Google Analytics. Your photos and server address are never
        sent.
      </p>
    )}
  </footer>
);
