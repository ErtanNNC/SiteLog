# Twilio SMS fixtures (W1-08)

Form fields of Twilio's messaging webhook and status callbacks, as `sms-webhook` receives them
(spec §9.5, F13, F15). Each file is `{ "path", "params" }`: `path` is the route after
`/sms-webhook` (`""` for inbound texts, `"/status"` for delivery callbacks), `params` the POST
fields. `pnpm replay-webhook -- fixtures/sms/*.json` signs them with `X-Twilio-Signature`
(`TWILIO_AUTH_TOKEN`) and posts them to a running `sms-webhook`.

Placeholders: `{{phone}}` the sender (`--phone`, default Marco Ruiz's `+15550143378`), `{{to}}`
the pack's sender id (`--to`, default `+18885550142`), `{{sid}}` a fresh message SID, and
`{{message_sid}}` the SID a status callback reports on (`--sid`).

For a local stack, set `SMS_WEBHOOK_URL=http://127.0.0.1:54321/functions/v1/sms-webhook` and
`TWILIO_AUTH_TOKEN` in `supabase/functions/.env` (the URL Twilio signs must be the one the function
checks), and the US pack's sender with `pnpm countries:set -- --code US --sms-sender +18885550142`
(on a local database only): `sms-webhook` finds the pack by `To`.
