# Twilio WhatsApp fixtures (W2-15, W2-16)

Form fields of Twilio's messaging webhook and status callbacks for **WhatsApp**, as `sms-webhook`
receives them (spec §9.5, §19 Q26, Q85; GAP D49 (2): there is no `whatsapp-webhook` for Twilio).
The same shape as `../sms/`: `{ "path", "params" }`, signed with `X-Twilio-Signature`
(`TWILIO_AUTH_TOKEN`) and posted by `pnpm replay-webhook -- fixtures/whatsapp/*.json`. The
addresses are `whatsapp:` ones: `{{phone}}` the person (`--phone`), `{{to}}` the pack's WhatsApp
sender (`--to`, the pack's `whatsapp_sender_id`), `{{sid}}` a fresh message SID,
`{{message_sid}}` the SID a status callback reports on (`--sid`), `{{wa_id}}` the person's number
without `+`.

| File                                | What it covers                                                         |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `inbound-help.json`                 | HELP on WhatsApp: the help text there, on every pack (TR included)     |
| `inbound-stop.json`                 | STOP: the `whatsapp` consent revoked, texts untouched (§19 Q40)        |
| `inbound-start.json`                | START: the `whatsapp` consent back for one who had given it (§19 Q112) |
| `inbound-answer.json`               | "5": the answer to the open web question (`whatsapp_answer`, §19 Q26)  |
| `inbound-ok.json`                   | OK: the open draft's link, on WhatsApp (§19 Q82)                       |
| `inbound-voice-note.json`           | a voice note: stored, never transcribed, the link once a day (§19 Q85) |
| `status-read.json`                  | a `read` receipt (msg_status `read`, D49)                              |
| `status-failed-outside-window.json` | 63016: free-form outside the window; the message goes on by SMS        |

For a local stack: the pack's WhatsApp sender with
`pnpm countries:set -- --code US --whatsapp-sender +15550142299` (a local database only), then
`pnpm replay-webhook -- --sms-url http://127.0.0.1:54321/functions/v1/sms-webhook --token <token> --to +15550142299 --phone <a real org's reporter> fixtures/whatsapp/inbound-help.json`.
A message from a real sender reaches real orgs only; demo orgs use the Demo phone's WhatsApp
thread. The worker (`pnpm dev:worker`) answers what `sms-webhook` stores.
