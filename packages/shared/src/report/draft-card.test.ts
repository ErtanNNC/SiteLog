import { describe, expect, it } from 'vitest';
import { emptyReportData } from '../schemas/report.ts';
import { exampleDraftCard, formatDraftCard, workItemPhrase } from './draft-card.ts';

describe('draft card', () => {
  it('renders the F7 layout', () => {
    const d = emptyReportData('2026-10-09');
    d.manpower = [
      {
        companyId: 'a',
        companyNameHeard: 'Apex',
        companyName: 'Apex Concrete',
        workers: 6,
        hoursPerWorker: 8,
        totalHours: 48,
        hoursBasis: 'stated',
        confidence: 0.9,
        source: [],
      },
      {
        companyId: 'b',
        companyNameHeard: 'BrightLine',
        companyName: 'BrightLine Electric',
        workers: 5,
        hoursPerWorker: 8,
        totalHours: 40,
        hoursBasis: 'stated',
        confidence: 0.9,
        source: [],
      },
      {
        companyId: 'd',
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        workers: 5,
        hoursPerWorker: 8,
        totalHours: 40,
        hoursBasis: 'reply',
        confidence: 1,
        source: [],
      },
      {
        companyId: 'i',
        companyNameHeard: 'Ironclad',
        companyName: 'Ironclad Steel',
        workers: 3,
        hoursPerWorker: 8,
        totalHours: 24,
        hoursBasis: 'stated',
        confidence: 0.9,
        source: [],
      },
      {
        companyId: 'k',
        companyNameHeard: 'our guys',
        companyName: 'Kestrel self-perform',
        workers: 4,
        hoursPerWorker: 8,
        totalHours: 32,
        hoursBasis: 'stated',
        confidence: 0.9,
        source: [],
      },
    ];
    d.weather = {
      conditionsText: 'Rain AM',
      periods: [
        {
          condition: 'Rain',
          start: '07:00',
          end: '10:30',
          impact: 'Masonry stopped; crew moved inside',
          lostHours: 3.5,
          source: [],
        },
      ],
    };
    d.workPerformed = [
      {
        area: 'Level 4',
        activity: 'Slab pour',
        status: 'complete',
        quantity: { value: 68, unit: 'yd³' },
        source: [],
      },
      {
        area: 'Level 3',
        activity: 'Electrical rough-in',
        status: 'in_progress',
        percentComplete: 60,
        source: [],
      },
      { area: 'Level 2', activity: 'Ductwork', status: 'in_progress', source: [] },
    ];
    d.deliveries = [{ item: 'Rebar', quantity: '2 loads', supplier: 'Ironclad', source: [] }];
    d.safety = {
      toolboxTalk: 'Wet-weather access',
      incidents: [],
      noIncidentsStated: true,
      visitors: [],
      source: [],
    };
    const card = formatDraftCard(d, { siteName: 'Riverside Lofts — Block B', totals: undefined });
    expect(card).toBe(
      [
        '```',
        'DRAFT · FRI OCT 9',
        'Riverside Lofts — Block B',
        'CREW      23 on site · 5 subs · 184 h',
        'WEATHER   Rain 07:00–10:30 · masonry stopped 3.5 h',
        'DONE      L4 slab pour complete · L3 electrical rough-in ~60% · L2 ductwork',
        'DELIVERED Rebar, 2 loads (Ironclad)',
        'SAFETY    Toolbox talk · no incidents',
        '```',
        'Reply OK to file it, or tell me what to fix.',
      ].join('\n'),
    );
  });
  it('shows pending values and stays short when sections are empty', () => {
    const d = emptyReportData('2026-10-09');
    d.manpower = [
      {
        companyId: null,
        companyNameHeard: 'crew',
        companyName: 'Crew',
        workers: null,
        hoursPerWorker: null,
        totalHours: null,
        hoursBasis: 'unknown',
        confidence: 0.5,
        source: [],
      },
    ];
    const card = formatDraftCard(d, { siteName: 'X', monospace: false, footer: null });
    expect(card).toContain('CREW      headcount pending · 1 sub · hours pending');
    expect(card).toContain('WEATHER   Not stated');
    expect(card).toContain('SAFETY    Not stated');
    expect(card).not.toContain('DELIVERED');
    expect(card).not.toContain('```');
  });
  it('phrases work items', () => {
    expect(
      workItemPhrase({
        area: 'Exterior — south elevation',
        activity: 'Masonry',
        status: 'stopped',
        source: [],
      }),
    ).toBe('Ext. south elevation masonry stopped');
    expect(exampleDraftCard()).toContain('EXAMPLE');
  });
});
