# fixtures/answers — the `parse_answer` golden set (W2-09, spec §10.7, §10.13)

One JSON per spoken answer to a clarification question (F7 _Other…_). Each file names:

- `question`: the field, the prompt as the reporter saw it, the offered options and the target
  (the crew's index and name), as `questions` holds them;
- `crew`: that crew in the draft before the answer (no numbers);
- `companies`, `defaultShiftHours`: what the worker gives the model besides the answer;
- `voice`: the `../voice/` clip (`kind: "answer"`) whose transcript is the answer;
- `recorded`: the `parse_answer` tool output (`{field, value, confidence}`);
- `expected`: what code must make of it: applied (`value`, and the crew in code: workers, hours
  per worker, total) or not (`reason`: `low_confidence`, `number_not_stated`, `other_field`).

| File                         | Language | What it covers                                                  |
| ---------------------------- | -------- | --------------------------------------------------------------- |
| `en-delta-five-all-day.json` | EN       | "Five, all day." → 5 × 8 h = 40 h (W2-09's Done-when)           |
| `es-delta-cinco.json`        | ES       | "Eran cinco, todo el día." → 5 × 8 h = 40 h                     |
| `tr-demirci-alti.json`       | TR       | "Demirciler altı kişiydi, tam gün çalıştılar." → 6 × 8 h = 48 h |
| `tr-akis-alti.json`          | TR       | W4-07, on a call: "Altı kişi, tam gün." → 6 × 8 h = 48 h        |
| `en-unclear.json`            | EN       | No answer in it: confidence 0.15, not applied, asked once more  |

## Not model recordings

No `ANTHROPIC_API_KEY` was available when W2-09 was built, so `recorded` is the output the prompt
asks for, written by hand. The set proves the code around the model (the job, the 0.7 rule, the
stated-numbers rule, the sources and totals in code), not the model. The model's check is

    pnpm eval -- --answers             # the live fast model (CLAUDE_MODEL_FAST, else CLAUDE_MODEL)
    pnpm eval -- --answers --recorded  # the recorded outputs, offline

Who reads them: `apps/worker/src/ai/answer-fixtures.ts` (loader and scoring), the fake Claude
(`EXTRACT_PROVIDER=fake`, which answers `parse_answer` with the recorded output of the case whose
transcript is the reply), `answer-fixtures.test.ts` and `integration/answer.integration.test.ts`.
