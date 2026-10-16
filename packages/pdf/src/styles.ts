import { StyleSheet } from '@react-pdf/renderer';
import { colors, printColors } from '@sitelog/shared';
import { FONT_MONO, FONT_SANS, FONT_SANS_EXPANDED } from './fonts';

/**
 * §12 ink: near-black on white, header fill and rules (print tokens), orange only on the badge
 * and the footer mark; section numbers in signal-deep, as the Report artboards print them.
 *
 * No `textTransform: 'uppercase'`: react-pdf upper-cases without a locale, which turns a Turkish
 * "i" into "I" instead of "İ". Labels are upper-cased in code with the report language
 * (`upper()` in copy.ts).
 */
export const INK = colors.asphalt;
export const INK_SOFT = colors.dust;
export const RULE = printColors.rule;
export const FILL = printColors.fill;
export const SIGNAL = colors.signal;
export const SIGNAL_DEEP = colors.signalDeep;
export const MARGIN = 54; // 0.75 in

export const styles = StyleSheet.create({
  // No lineHeight on the page: react-pdf drops render-prop text inside fixed elements when the page sets it.
  page: {
    paddingTop: 48,
    paddingBottom: 60,
    paddingHorizontal: MARGIN,
    fontFamily: FONT_SANS,
    fontSize: 9.5,
    color: INK,
  },
  letterhead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  orgName: { fontFamily: FONT_SANS_EXPANDED, fontWeight: 800, fontSize: 14, letterSpacing: -0.2 },
  orgLine: { fontSize: 8.5, color: INK_SOFT, marginTop: 1 },
  logo: { maxHeight: 36, maxWidth: 150, objectFit: 'contain' },
  badgeWrap: { alignItems: 'flex-end' },
  badge: {
    backgroundColor: SIGNAL,
    color: INK,
    fontFamily: FONT_SANS_EXPANDED,
    fontWeight: 800,
    fontSize: 9,
    letterSpacing: 0.6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 3,
  },
  reportNo: { fontFamily: FONT_MONO, fontWeight: 500, fontSize: 9, marginTop: 5 },
  rule: { borderBottomWidth: 2, borderBottomColor: INK, marginBottom: 12 },
  h1: {
    fontFamily: FONT_SANS_EXPANDED,
    fontWeight: 800,
    fontSize: 20,
    letterSpacing: -0.4,
    marginBottom: 10,
  },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderTopColor: RULE,
    marginBottom: 14,
  },
  metaCell: {
    width: '33.33%',
    paddingVertical: 6,
    paddingRight: 8,
    borderBottomWidth: 1,
    borderBottomColor: RULE,
  },
  eyebrow: {
    fontFamily: FONT_MONO,
    fontWeight: 500,
    fontSize: 7,
    letterSpacing: 0.8,
    color: INK_SOFT,
    marginBottom: 2,
  },
  metaValue: { fontSize: 9.5, fontWeight: 600 },
  section: { marginBottom: 12 },
  sectionTitle: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 5 },
  sectionNo: { fontFamily: FONT_MONO, fontWeight: 600, fontSize: 8, color: SIGNAL_DEEP, width: 20 },
  // flex: 1 so a long upper-case title wraps inside its column instead of running into the next.
  sectionName: {
    flex: 1,
    fontFamily: FONT_SANS_EXPANDED,
    fontWeight: 700,
    fontSize: 10.5,
    letterSpacing: 0.2,
  },
  body: { fontSize: 9.5 },
  muted: { color: INK_SOFT },
  table: { borderTopWidth: 1, borderTopColor: RULE },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: RULE, minHeight: 16 },
  th: {
    backgroundColor: FILL,
    fontFamily: FONT_MONO,
    fontWeight: 500,
    fontSize: 7,
    letterSpacing: 0.6,
    color: INK_SOFT,
    paddingVertical: 4,
    paddingHorizontal: 5,
  },
  td: { paddingVertical: 4, paddingHorizontal: 5, fontSize: 9, lineHeight: 1.35 },
  tdMono: { fontFamily: FONT_MONO, fontWeight: 500, fontSize: 8.5 },
  tdRight: { textAlign: 'right' },
  totalRow: { backgroundColor: FILL, fontWeight: 700 },
  footnote: { fontSize: 7.5, color: INK_SOFT, marginTop: 4 },
  columns: { flexDirection: 'row', marginHorizontal: -6 },
  column: { flex: 1, paddingHorizontal: 6 },
  bullet: { flexDirection: 'row', marginBottom: 2 },
  bulletDot: { width: 8, fontFamily: FONT_MONO },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  photoCell: { width: '50%', paddingHorizontal: 4, marginBottom: 8 },
  photo: { width: '100%', height: 150, objectFit: 'cover', borderWidth: 1, borderColor: RULE },
  photoCaption: { fontFamily: FONT_MONO, fontSize: 7.5, color: INK_SOFT, marginTop: 3 },
  signoff: { flexDirection: 'row', marginTop: 18, marginHorizontal: -12 },
  signBox: { flex: 1, marginHorizontal: 12 },
  // The line the signature goes on; the confirmation or sign-off prints on it (Report-P2).
  signLine: {
    height: 30,
    borderBottomWidth: 1,
    borderBottomColor: INK,
    justifyContent: 'flex-end',
    paddingBottom: 3,
  },
  signLineText: { fontFamily: FONT_MONO, fontSize: 8.5 },
  signCaption: { fontSize: 9, marginTop: 4 },
  signRole: { fontWeight: 700 },
  runningHeader: {
    position: 'absolute',
    top: 20,
    left: MARGIN,
    right: MARGIN,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontFamily: FONT_MONO,
    fontSize: 7,
    color: INK_SOFT,
    borderBottomWidth: 1,
    borderBottomColor: RULE,
    paddingBottom: 4,
  },
  footer: {
    position: 'absolute',
    bottom: 26,
    left: MARGIN,
    right: MARGIN,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: FONT_MONO,
    fontSize: 7,
    color: INK_SOFT,
    borderTopWidth: 1,
    borderTopColor: RULE,
    paddingTop: 5,
  },
  footerLeft: { flexDirection: 'row', alignItems: 'center' },
  chip: {
    fontFamily: FONT_MONO,
    fontSize: 6.5,
    letterSpacing: 0.4,
    paddingVertical: 1,
    paddingHorizontal: 3,
    borderWidth: 1,
    borderColor: RULE,
    borderRadius: 2,
    marginLeft: 4,
    color: INK_SOFT,
  },
  coverTitle: {
    fontFamily: FONT_SANS_EXPANDED,
    fontWeight: 800,
    fontSize: 28,
    letterSpacing: -0.6,
    marginTop: 120,
    marginBottom: 8,
  },
  coverSub: { fontSize: 13, color: INK_SOFT, marginBottom: 24 },
  dayHeader: {
    backgroundColor: FILL,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  dayTitle: { fontFamily: FONT_SANS_EXPANDED, fontWeight: 800, fontSize: 13 },
  excerpt: { flexDirection: 'row', marginBottom: 3 },
  // Wide enough for a clip label ("sesli not 2 · 0:41–0:47", W3-07).
  excerptTs: { fontFamily: FONT_MONO, fontSize: 8, width: 120, color: INK_SOFT },
  excerptText: { flex: 1, fontSize: 9, lineHeight: 1.4 },
});
