# fixtures/corrections — the `apply_correction` golden set (W2-10, spec §10.6, §10.13)

One JSON per fix of a draft said on the recorder (F8 _Fix by voice_). Each file names:

- `draft`: the golden extraction case (`../expected/<id>.json`) whose data is the draft before the
  fix (its companies and default shift come from `../transcripts/<id>.json`);
- `voice`: the `../voice/` clip (`kind: "correction"`) whose transcript is the fix;
- `recorded`: the `apply_correction` tool output (`{operations, changeNote, needsClarification}`);
- `expected`: what code must make of it: applied (the crew in code: workers, hours per worker,
  total; the preview's lines; how many totals were dropped; `clarificationOk` when a question
  instead is right too) or not (`reason`: `clarification`, or a refusal of `applyCorrectionOps`).

| File                 | Language | What it covers                                                                    |
| -------------------- | -------- | --------------------------------------------------------------------------------- |
| `en-apex-seven.json` | EN       | "Apex had seven, not six." → 7 × 8 h = 56 h (W2-10's Done-when)                   |
| `es-apex-siete.json` | ES       | "Los de Apex eran siete, no seis." → 7 × 8 h = 56 h                               |
| `tr-usta-bes.json`   | TR       | "Usta Beton dört değil, beş kişiydi." → 5 × 8 saat = 40 saat                      |
| `tr-usta-alti.json`  | TR       | W4-07, on a call: "Usta Beton beş değil, altı kişiydi." → 6 × 8 saat = 48 saat    |
| `en-which-crew.json` | EN       | "Change it to three." names no crew: the model asks which one, nothing is applied |
| `en-apex-total.json` | EN       | The model also sets Apex's total to 60: code drops it, 7 × 8 h = 56 h; or it asks |

## Not model recordings

No `ANTHROPIC_API_KEY` was available when W2-10 was built, so `recorded` is the output the prompt
asks for, written by hand. The set proves the code around the model (the job, the paths a fix may
touch, the stated-numbers rule, totals and sources in code), not the model. The model's check is

    pnpm eval -- --corrections             # the live model (CLAUDE_MODEL)
    pnpm eval -- --corrections --recorded  # the recorded outputs, offline

Who reads them: `apps/worker/src/ai/correction-fixtures.ts` (loader and scoring), the fake Claude
(`EXTRACT_PROVIDER=fake`, which answers `apply_correction` with the recorded output of the case
whose transcript is the fix), `correction-fixtures.test.ts` and
`integration/correction.integration.test.ts`.
