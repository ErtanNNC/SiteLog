/** The hero voice note (§18): Marco Ruiz, Riverside Lofts — Block B, Fri Oct 9, 2 min 48 s, Spanish + English. */
export const heroTranscriptSegments: Array<{ start: number; end: number; text: string }> = [
  { start: 0, end: 8.2, text: 'Okay, Friday, Riverside Block B. Big day on four.' },
  {
    start: 8.2,
    end: 18.9,
    text: 'We poured the deck on four, like sixty-eight yards, finished about two thirty. Apex had six guys on it.',
  },
  {
    start: 18.9,
    end: 30.5,
    text: "BrightLine, five electricians on three doing the rough-in, I'd say sixty percent.",
  },
  { start: 30.5, end: 41.0, text: 'The Delta guys were on two running duct on the east wing.' },
  {
    start: 41.0,
    end: 52.3,
    text: 'Llovió desde las siete hasta las diez y media, no pudimos hacer block afuera, los de masonry se metieron adentro, perdimos como tres horas y media.',
  },
  {
    start: 52.3,
    end: 63.0,
    text: 'Ironclad dropped two loads of rebar around one, three of their guys stayed to tie.',
  },
  { start: 63.0, end: 74.4, text: 'Our guys, four of us, cleaning and layout for five.' },
  {
    start: 74.4,
    end: 86.0,
    text: 'Toolbox talk this morning on wet weather access, no incidents.',
  },
  { start: 86.0, end: 98.5, text: 'Monday we need the pump at seven for the level five deck.' },
  {
    start: 98.5,
    end: 112.0,
    text: 'Ah, y el inspector de la ciudad vino a ver el colado, todo bien, firmó.',
  },
  {
    start: 112.0,
    end: 128.0,
    text: 'One more thing, the west stair, the handrail is still missing on three, I put a barricade, we need the steel guys next week.',
  },
  {
    start: 128.0,
    end: 146.0,
    text: 'Photos coming, one of the pour and one of the rain this morning so you have it for the record.',
  },
  { start: 146.0, end: 168.0, text: "That's it, that's Friday. Have a good weekend." },
];

export function heroSummary(crew: number, hours: number): string {
  return (
    `Level 4 slab pour completed by Apex Concrete (approx. 68 yd³, finished 14:30). Rain 07:00–10:30 stopped exterior masonry for 3.5 h; crew moved to interior blockwork. ` +
    `Level 3 electrical rough-in approximately 60% complete; Level 2 ductwork in progress, east wing. Ironclad Steel delivered two loads of rebar at 13:00. ` +
    `City inspector approved the pour. Handrail missing at west stair Level 3, barricaded. ${crew} on site, ${hours} h. Toolbox talk on wet-weather access; no incidents.`
  );
}
