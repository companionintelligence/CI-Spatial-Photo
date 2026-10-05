/**
 * Where this viewer sends people who want the rest of Companion Intelligence.
 *
 * One module, because the same four destinations and the same wording appear in the
 * header, the first-run card, the empty-state hero and the footer — and a link that is
 * correct in three of those four places is how a site ends up with a dead "Buy" button.
 *
 * Wording is the main site's own. The labels are the fleet-wide ones used on every
 * *.ci.computer page ("Buy Companion Core", "Download Companion"); the two blurbs are
 * lifted from ci.computer/core ("A private, cloud-free AI lab for individuals, learners,
 * and creators.") and ci.computer/download ("Companion Hub runs on your hardware."), and
 * the tagline is the one on the ci.computer home page and at the end of this product's
 * own film. Nothing here states a price, a spec, or what Core or Hub can run — that is
 * ci.computer's to say, one click away.
 *
 * `BUY_URL` is written as /core, exactly, even though the main site redirects it to
 * /store/p/core: /core is the stable address and the redirect target is the store's to
 * move.
 */

export const SITE_URL = 'https://ci.computer';
export const BUY_URL = 'https://ci.computer/core';
export const DOWNLOAD_URL = 'https://ci.computer/download';

/**
 * The public docs. There is no page for this service yet — `first-party-apps/photogram`
 * documents the Hub globe demo of the same name and says so ("don't confuse it with the
 * separate Photo Time Machine service at photo.ci.computer"), so linking it from here
 * would send a visitor to a page that disowns them. The docs index is the honest target
 * until a dedicated page exists; when it does, this is the one line to change. The
 * Worker's /docs redirect (worker/index.js) carries the same URL and must change with it.
 */
export const DOCS_URL = 'https://docs.ci.computer/docs';

export const BRAND_NAME = 'Companion Intelligence';
export const TAGLINE = 'UnCloud your life.';

export const BUY_LABEL = 'Buy Companion Core';
export const BUY_BLURB = 'A private, cloud-free AI lab for individuals, learners, and creators.';

export const DOWNLOAD_LABEL = 'Download Companion';
export const DOWNLOAD_BLURB = 'Companion Hub runs on your hardware.';

/**
 * The hostname this viewer is published at. The Worker there has no processing server
 * behind it (it is a static edge), which two pieces of UI need to know.
 */
export const HOSTED_VIEWER_HOST = 'photo.ci.computer';
