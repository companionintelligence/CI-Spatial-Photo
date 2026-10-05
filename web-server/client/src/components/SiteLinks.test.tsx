import React from 'react';
// Imported per-suite, as in TopBar.test.tsx: this repo has no src/setupTests.ts.
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { BrandLink, CompanionCallouts, SiteFooter } from './SiteLinks';
import { BUY_LABEL, BUY_URL, DOCS_URL, DOWNLOAD_LABEL, DOWNLOAD_URL, SITE_URL } from '../siteLinks';

/**
 * Contract tests for the links back out to ci.computer.
 *
 * Two things here were wrong in the field and are invisible to a type checker and to a
 * test that only looks at hrefs: the hero's Buy and Download buttons did nothing when
 * CLICKED (a mouse click fell through to the 3D scene behind them) while still showing a
 * Tab ring, and the Docs link pointed at a page that 404s.
 */

/**
 * What the browser would resolve `pointer-events` to for an element.
 *
 * jsdom loads no Tailwind, so `getComputedStyle` cannot answer this. The property is
 * inherited, and the only declarations in play are the `pointer-events-none` /
 * `pointer-events-auto` utility classes, so walking up to the nearest element that carries
 * one is exactly the cascade. (`auto` is also what the root defaults to.)
 */
function effectivePointerEvents(el: Element): 'none' | 'auto' {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.classList.contains('pointer-events-none')) return 'none';
    if (node.classList.contains('pointer-events-auto')) return 'auto';
  }
  return 'auto';
}

/**
 * The overlay the links render into in App.tsx: `pointer-events-none`, so the empty space
 * still orbits the model behind it. The links must work from inside it with NOTHING else
 * between them and it re-enabling pointer events — the shape that broke.
 */
const InOverlay: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="pointer-events-none">{children}</div>
);

describe('pointer events under the HUD overlay', () => {
  it.each(['hero', 'card'] as const)('%s callouts take mouse clicks', (variant) => {
    render(
      <InOverlay>
        <CompanionCallouts variant={variant} />
      </InOverlay>,
    );
    for (const name of [BUY_LABEL, DOWNLOAD_LABEL]) {
      const link = screen.getByRole('link', { name });
      expect(effectivePointerEvents(link)).toBe('auto');
    }
  });

  it('the header logo link takes mouse clicks', () => {
    render(
      <InOverlay>
        <BrandLink />
      </InOverlay>,
    );
    expect(effectivePointerEvents(screen.getByRole('link', { name: /companion intelligence home/i }))).toBe('auto');
  });

  it('every footer link takes mouse clicks', () => {
    render(
      <InOverlay>
        <SiteFooter />
      </InOverlay>,
    );
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const link of links) expect(effectivePointerEvents(link)).toBe('auto');
  });

  it('the helper itself sees a link left under the overlay as dead', () => {
    // Guards the guard: if this started passing, the tests above would prove nothing.
    render(
      <InOverlay>
        <a href="https://example.test/">bare</a>
      </InOverlay>,
    );
    expect(effectivePointerEvents(screen.getByRole('link', { name: 'bare' }))).toBe('none');
  });
});

describe('destinations', () => {
  it('footer and callouts link to the same places, Buy before Download in both', () => {
    const { container } = render(
      <>
        <CompanionCallouts variant="hero" />
        <SiteFooter />
      </>,
    );
    const order = (root: Element) =>
      Array.from(root.querySelectorAll('a'))
        .map((a) => a.getAttribute('href'))
        .filter((href) => href === BUY_URL || href === DOWNLOAD_URL);
    const [callouts, footer] = Array.from(container.children);
    expect(order(callouts)).toEqual([BUY_URL, DOWNLOAD_URL]);
    expect(order(footer)).toEqual([BUY_URL, DOWNLOAD_URL]);
  });

  it('the footer links home and to the docs', () => {
    render(<SiteFooter />);
    expect(screen.getByRole('link', { name: 'Companion Intelligence' })).toHaveAttribute('href', SITE_URL);
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', DOCS_URL);
  });

  it('does not point the docs at docs.ci.computer/docs, which is a 404', () => {
    // The docs site has no index at /docs (its pages are /docs/introduction and the like),
    // so the bare path is the site's own "page could not be found".
    expect(new URL(DOCS_URL).pathname.replace(/\/+$/, '')).not.toBe('/docs');
    expect(new URL(DOCS_URL).origin).toBe('https://docs.ci.computer');
  });
});
