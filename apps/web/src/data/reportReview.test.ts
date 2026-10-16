import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { assembleReportDetail, assembleReportItems, hasNoPhoto, reportChannel } from './assemble';

/** W1-17 loaders: clips, activity and the archive's channel and No-photo flag (§18.1 data). */

function hero(store = new DemoStore()) {
  const report = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
  return { store, report };
}

const ctx = (store: DemoStore) => ({ now: store.now, userId: 'u' });

describe('Report review loaders (W1-17)', () => {
  it('reads every voice note of the report from its upload, with its own transcript', () => {
    const { store, report } = hero();
    const d = assembleReportDetail(store.rows(), ctx(store), report.id);
    expect(d.clips.map((c) => c.kind)).toEqual(['voice_note', 'voice_note']);
    const [note, fix] = d.clips;
    expect(note!.bucket).toBe('audio');
    expect(note!.storagePath).toMatch(/\.webm$/);
    expect(note!.languages).toEqual(['es', 'en']);
    expect(note!.excerpts.length).toBeGreaterThanOrEqual(4);
    // The 20:09 correction cites its own clip; the 17:38 note's excerpts skip Apex in v2.
    expect(fix!.excerpts.map((e) => e.mapped)).toEqual([
      expect.stringMatching(/^Apex Concrete · 7 workers × 8 = 56 h/),
    ]);
    expect(note!.excerpts.some((e) => e.mapped.startsWith('Apex'))).toBe(false);
  });

  it('falls back to the WhatsApp message for a voice note without an upload', () => {
    const { store, report } = hero();
    const rows = store.rows();
    const src = rows.sources.find((s) => s.report_id === report.id && s.kind === 'voice_note')!;
    const upload = rows.uploads!.find((u) => u.id === src.upload_id)!;
    // As before the step 10 backfill: the message holds the file and its peaks.
    rows.uploads = rows.uploads!.filter((u) => u.id !== upload.id);
    rows.messages = [
      ...rows.messages,
      {
        ...rows.messages[0]!,
        id: upload.id,
        conversation_id: null,
        type: 'audio',
        storage_path: upload.storage_path,
        duration_s: upload.duration_s,
        payload: { peaks: upload.peaks },
        created_at: upload.received_at!,
        channel: null,
      },
    ];
    rows.sources = rows.sources.map((s) =>
      s.id === src.id ? { ...s, kind: 'audio', message_id: upload.id, upload_id: null } : s,
    );
    rows.transcripts = rows.transcripts.map((t) =>
      t.upload_id === upload.id ? { ...t, upload_id: null, message_id: upload.id } : t,
    );
    const d = assembleReportDetail(rows, ctx(store), report.id);
    expect(d.clips[0]).toMatchObject({ id: upload.id, durationS: 168, kind: 'voice_note' });
    expect(d.clips[0]!.peaks).toHaveLength(64);
    expect(d.clips[0]!.excerpts.length).toBeGreaterThanOrEqual(4);
  });

  it('builds Activity from uploads, questions and the audit log, in time order', () => {
    const { store, report } = hero();
    const d = assembleReportDetail(store.rows(), ctx(store), report.id);
    const kinds = d.activity.map((a) => a.kind);
    expect(kinds.indexOf('clip_received')).toBeLessThan(kinds.indexOf('question_asked'));
    expect(kinds.indexOf('question_answered')).toBeLessThan(kinds.indexOf('confirmed'));
    expect(kinds.indexOf('confirmed')).toBeLessThan(kinds.indexOf('filed'));
    expect(kinds.indexOf('filed')).toBeLessThan(kinds.indexOf('version'));
    // "Voice note + 2 photos received" at 17:38; the question rows replace their audit rows.
    expect(d.activity.find((a) => a.kind === 'clip_received')!.params).toEqual({
      seconds: 168,
      photos: 2,
    });
    expect(kinds.filter((k) => k === 'question_answered')).toHaveLength(1);
    const answer = d.activity.find((a) => a.kind === 'question_answered')!;
    expect(answer).toMatchObject({ detail: '5 · full day', actorName: 'Marco Ruiz' });
    expect(answer.anchor).toBe(d.questions[0]!.id);
    expect(d.activity.find((a) => a.kind === 'version')).toMatchObject({
      params: { version: 2, channel: 'web' },
      detail: 'Apex Concrete 6 → 7 workers',
    });
    // The texts of the day: "filed" and "edit_applied" (SMS, console driver).
    const texts = d.activity.filter((a) => a.kind === 'text_sent').map((a) => a.params.message);
    expect(texts).toEqual(expect.arrayContaining(['daily_link', 'filed', 'edit_applied']));
    expect(d.activity.filter((a) => a.kind === 'text_sent').every((a) => a.detail === null)).toBe(
      true,
    );
  });

  it('adds the reporter’s link openings of that day', () => {
    const { store, report } = hero();
    const rows = store.rows();
    const at = '2026-10-09T22:37:00.000Z'; // 17:37 in Chicago
    rows.audit = [
      ...rows.audit,
      {
        id: 999_001,
        org_id: report.org_id,
        actor_type: 'reporter',
        actor_id: report.reporter_id,
        action: 'link.opened',
        entity: 'field_link',
        entity_id: 'link',
        diff: { kind: 'daily' },
        created_at: at,
      },
      // Another day's opening is not this report's.
      {
        id: 999_002,
        org_id: report.org_id,
        actor_type: 'reporter',
        actor_id: report.reporter_id,
        action: 'link.opened',
        entity: 'field_link',
        entity_id: 'link',
        diff: { kind: 'daily' },
        created_at: '2026-10-08T22:37:00.000Z',
      },
    ];
    const d = assembleReportDetail(rows, ctx(store), report.id);
    expect(d.activity.filter((a) => a.kind === 'link_opened').map((a) => a.at)).toEqual([at]);
  });

  it('plays a call report’s recording and logs its calls', () => {
    const store = new DemoStore();
    const report = store.data.reports.find(
      (r) => r.channel === 'voice' && r.report_no.startsWith('NG-'),
    )!;
    const d = assembleReportDetail(store.rows(), ctx(store), report.id);
    expect(d.clips).toEqual([
      expect.objectContaining({ kind: 'call', bucket: 'calls', url: null }),
    ]);
    expect(d.report).toMatchObject({ channel: 'voice', confirmedVia: 'voice' });
    expect(d.activity.map((a) => a.kind)).toContain('call_in');
  });
});

describe('Reports archive: channel and No photo (P6)', () => {
  it('maps field channels to the icon', () => {
    expect(reportChannel('web')).toBe('link');
    expect(reportChannel('voice')).toBe('call');
    expect(reportChannel('sms')).toBe('link');
    expect(reportChannel('office')).toBe('office');
    expect(reportChannel(null)).toBeNull();
  });

  it('flags No photo for a report without one, never for a weather day', () => {
    const { report } = hero();
    expect(hasNoPhoto(report, 2)).toBe(false);
    expect(hasNoPhoto(report, 0)).toBe(true);
    expect(hasNoPhoto(report, null)).toBe(false);
    expect(hasNoPhoto({ ...report, kind: 'weather_day' }, 0)).toBe(false);
    expect(hasNoPhoto({ ...report, review_reasons: ['no_photo'] }, null)).toBe(true);
  });

  it('flags the call reports of Oct 9 (no photos on a call) and not the hero', () => {
    const store = new DemoStore();
    const rows = store.rows();
    const today = rows.reports.filter(
      (r) => r.channel === 'voice' || r.report_no === 'RL-2041-0187',
    );
    const items = assembleReportItems(rows, today);
    for (const i of items) {
      const noPhoto = i.flags.some((f) => f.kind === 'no_photo');
      if (i.reportNo === 'RL-2041-0187') expect(noPhoto).toBe(false);
      else if (i.kind !== 'weather_day') expect(noPhoto, i.reportNo).toBe(true);
      expect(i.channel).toBe(i.reportNo === 'RL-2041-0187' ? 'link' : 'call');
    }
  });

  it('names the reporter who made a version (W2-11, §19 Q81: a backup may change the day)', () => {
    const { store, report } = hero();
    const rows = store.rows();
    const backup = rows.reporters.find((r) => r.id !== report.reporter_id)!;
    const v2 = rows.versions.find((v) => v.report_id === report.id && v.version === 2)!;
    expect(assembleReportDetail(rows, ctx(store), report.id).versions[1]!.authorName).toBe(
      'Marco Ruiz',
    );
    rows.versions = rows.versions.map((v) =>
      v === v2 ? { ...v, author_reporter_id: backup.id } : v,
    );
    expect(assembleReportDetail(rows, ctx(store), report.id).versions[1]!.authorName).toBe(
      backup.name,
    );
  });
});
