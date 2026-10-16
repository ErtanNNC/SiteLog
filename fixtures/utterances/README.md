# fixtures/utterances — the `classify_utterance` golden set (W2-12, spec §10.8, §10.13)

One JSON per text the fast model classifies: an SMS EDIT on a two-way pack today, a call turn
outside the main report from M7. Each file names:

- `channel`: `sms` (call turns come with M7);
- `language`: the reporter's (EN, ES, TR);
- `text`: the whole inbound text, as the worker sends it;
- `recorded`: the `classify_utterance` tool output (`{intent, confidence, entities, correctionText}`);
- `expected`: what the model must return: the intent, the day as written (`dayReference`, which
  code resolves to a date, never the model) and the words of the change (`correctionText`).

| File                    | Language | What it covers                                                        |
| ----------------------- | -------- | --------------------------------------------------------------------- |
| `en-edit-fri-apex.json` | EN       | "EDIT FRI Apex was 7 not 6": Friday, Apex's headcount (the Done-when) |
| `es-edit-viernes.json`  | ES       | "EDITAR viernes Apex eran 7, no 6"                                    |
| `tr-edit-cuma.json`     | TR       | "DÜZELT cuma Demirci 5 kişiydi, 4 değil"                              |
| `en-edit-no-day.json`   | EN       | "EDIT Apex was 7": no day, so no report is changed (spec §19 Q102)    |

## Not model recordings

No `ANTHROPIC_API_KEY` was available when W2-12 was built, so `recorded` is the output the prompt
asks for, written by hand. The set proves the code around the model (the day resolved in code, the
report found in code, the preview made by `apply_correction` and code), not the model; a live run
needs the key: `pnpm eval -- --utterances` (the fast model, as the `sms_keyword` job calls it), or
`--utterances --recorded` offline.

Who reads them: `apps/worker/src/ai/utterance-fixtures.ts` (the loader) and the fake Claude
(`EXTRACT_PROVIDER=fake`), which answers `classify_utterance` with the recorded output of the case
whose `text` is the message.
