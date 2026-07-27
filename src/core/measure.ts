/**
 * Display width of a line, in columns.
 *
 * Uses UTF-16 code unit count (`string.length`) rather than grapheme-cluster width. This
 * undercounts wide CJK characters (which render at ~2 columns) and overcounts surrogate-pair
 * astral characters and combining marks (which render at ~0-1 columns). This is a real gap, not an
 * oversight. Plan §13 risk 4: pull in grapheme segmentation only once the differential corpus
 * (plan §9.3, phase 4) shows a consumer repo has comment content where this actually matters.
 * Until then this keeps the tool at zero runtime dependencies and its startup cost near zero.
 */
export function measure(line: string): number {
  return line.length;
}
