import type { StarterTerm } from './starter.ts';

/**
 * The English starter glossary (spec §19 Q238, W4-08; listed in spec §18.3): US site words → how a
 * daily report writes them. Written by SiteLog from the spec's own field words (§18.1's "the deck",
 * "block", "rough-in", "punch", "topped out", "stood down", "yards", "mud") and common US site
 * vocabulary (formwork, equipment, safety, inspections). No company, crew or area names. A new org
 * whose report language is English starts with these as `built_in` (`seed_starter_glossary()`,
 * 20261017000410_starter_glossary.sql, which must hold the same rows).
 */
export const STARTER_GLOSSARY_EN: readonly StarterTerm[] = [
  // Concrete, steel and masonry
  { heard: 'the deck', official: 'Elevated concrete slab', kind: 'term' },
  { heard: 'the iron', official: 'Reinforcing steel (rebar)', kind: 'term' },
  { heard: 'forms', official: 'Concrete formwork', kind: 'term' },
  { heard: 'stripped forms', official: 'Formwork stripped', kind: 'term' },
  { heard: 'pump truck', official: 'Concrete pump truck', kind: 'term' },
  { heard: 'ready-mix', official: 'Ready-mix concrete', kind: 'term' },
  { heard: 'block', official: 'Concrete masonry units (CMU)', kind: 'term' },
  { heard: 'topped out', official: 'Structural frame complete to roof level', kind: 'term' },
  // Interiors and MEP
  { heard: 'drywall', official: 'Gypsum board (drywall)', kind: 'term' },
  { heard: 'mud', official: 'Joint compound', kind: 'term' },
  { heard: 'rough-in', official: 'MEP rough-in', kind: 'term' },
  { heard: 'MEP', official: 'Mechanical, electrical and plumbing (MEP)', kind: 'term' },
  { heard: 'punch', official: 'Punch list items', kind: 'term' },
  // Equipment
  { heard: 'man lift', official: 'Aerial work platform', kind: 'term' },
  { heard: 'scissor lift', official: 'Aerial work platform (scissor lift)', kind: 'term' },
  // Safety and inspections
  { heard: 'toolbox talk', official: 'Toolbox safety talk', kind: 'term' },
  { heard: 'tailgate meeting', official: 'Toolbox safety talk', kind: 'term' },
  { heard: 'PPE', official: 'Personal protective equipment (PPE)', kind: 'term' },
  { heard: 'near miss', official: 'Near-miss incident', kind: 'term' },
  { heard: 'first aid', official: 'First-aid case', kind: 'term' },
  { heard: 'green tag', official: 'Inspection passed (green tag)', kind: 'term' },
  { heard: 'red tag', official: 'Inspection failed (red tag)', kind: 'term' },
  // Delays
  { heard: 'stood down', official: 'Work stoppage', kind: 'term' },
  { heard: 'rained out', official: 'Work stoppage (rain)', kind: 'term' },
  // People and records
  { heard: 'the GC', official: 'General contractor', kind: 'term' },
  { heard: 'subs', official: 'Subcontractors', kind: 'term' },
  { heard: 'OT', official: 'Overtime', kind: 'term' },
  { heard: 'RFI', official: 'Request for information (RFI)', kind: 'term' },
  // Units
  { heard: 'yards', official: 'Cubic yards (yd³)', kind: 'unit' },
];
