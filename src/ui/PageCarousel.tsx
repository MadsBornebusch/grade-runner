import { useEffect, useRef, useState, type ReactNode } from "react";

interface PageCarouselProps {
  pages: { label: string; content: ReactNode }[];
}

/**
 * Horizontally-paged layout: native touch swipe via CSS scroll-snap (no
 * gesture library needed), plus prev/next buttons and dot indicators for
 * mouse/keyboard use. Pages stay laid out at full width even when scrolled
 * out of view (never display:none) so their charts measure a real
 * container width via ResizeObserver and render correctly the moment you
 * swipe to them, instead of only after their own resize event.
 */
export function PageCarousel({ pages }: PageCarouselProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  const scrollingFromClickRef = useRef(false);
  // Flex items in a row default to matching the tallest sibling's height, so
  // a short page (e.g. Course) would otherwise inherit a much taller box
  // from a longer one (e.g. Results) once pages scroll with the page rather
  // than in their own boxed area. Track the active page's own height instead
  // so the carousel is only ever as tall as what's actually showing.
  const [trackHeight, setTrackHeight] = useState<number | null>(null);

  useEffect(() => {
    const activePage = pageRefs.current[current];
    if (!activePage) return;
    const resizeObserver = new ResizeObserver(() => setTrackHeight(activePage.scrollHeight));
    resizeObserver.observe(activePage);
    return () => resizeObserver.disconnect();
  }, [current]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame: number | null = null;
    const onScroll = () => {
      if (scrollingFromClickRef.current) return;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const pageWidth = track.clientWidth;
        if (pageWidth > 0) setCurrent(Math.round(track.scrollLeft / pageWidth));
      });
    };
    track.addEventListener("scroll", onScroll, { passive: true });

    // On rotation/resize, clientWidth changes but scrollLeft doesn't, so the
    // old pixel offset no longer lands on a page boundary. Re-align to the
    // current page instead of leaving the view stranded mid-page.
    const resizeObserver = new ResizeObserver(() => {
      track.scrollLeft = currentRef.current * track.clientWidth;
    });
    resizeObserver.observe(track);

    return () => {
      track.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  const goTo = (index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.max(0, Math.min(pages.length - 1, index));
    scrollingFromClickRef.current = true;
    track.scrollTo({ left: clamped * track.clientWidth, behavior: "smooth" });
    setCurrent(clamped);
    // Scroll-driven onScroll events keep firing during the smooth scroll;
    // ignore them until it's had time to settle, so they don't fight the
    // click-driven `current` we just set.
    window.setTimeout(() => {
      scrollingFromClickRef.current = false;
    }, 400);
  };

  return (
    <div className="page-carousel">
      <div
        className="page-carousel__track"
        ref={trackRef}
        style={trackHeight != null ? { height: `${trackHeight}px` } : undefined}
      >
        {pages.map((page, i) => (
          <div
            className="page-carousel__page"
            key={page.label}
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
          >
            {page.content}
          </div>
        ))}
      </div>
      <div className="page-carousel__nav">
        <button
          type="button"
          className="page-carousel__arrow"
          onClick={() => goTo(current - 1)}
          disabled={current === 0}
          aria-label="Previous page"
        >
          &lsaquo;
        </button>
        <div className="page-carousel__dots">
          {pages.map((page, i) => (
            <button
              type="button"
              key={page.label}
              className={`page-carousel__dot ${i === current ? "active" : ""}`}
              onClick={() => goTo(i)}
              aria-label={`Go to ${page.label}`}
              aria-current={i === current}
            >
              <span className="page-carousel__dot-label">{page.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="page-carousel__arrow"
          onClick={() => goTo(current + 1)}
          disabled={current === pages.length - 1}
          aria-label="Next page"
        >
          &rsaquo;
        </button>
      </div>
    </div>
  );
}
