export interface SectionPosition {
  id: string;
  top: number;
}

/**
 * Scroll-spy fallback for browsers without IntersectionObserver (notably
 * Safari 11). The last heading that crossed the sticky-header offset wins;
 * before the first crossing, keep the first available section active.
 */
export function chooseActiveSection(
  positions: SectionPosition[],
  headerOffset = 96,
): string | null {
  if (positions.length === 0) return null;
  let active = positions[0].id;
  for (const position of positions) {
    if (position.top > headerOffset) break;
    active = position.id;
  }
  return active;
}
