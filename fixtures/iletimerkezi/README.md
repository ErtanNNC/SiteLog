# İletimerkezi fixtures (W4-11)

The mocked İletimerkezi the driver and the `sms_status` job are tested against (spec §19 Q237;
no account or key exists yet, W4-13).

- `send-accepted.json`: the answer of `POST /v1/send-sms/json` to an accepted order, in the shape
  the driver has assumed since W1-08 (`response.status.code` `200`, `response.order.id`). Not
  confirmed against the provider (spec §19 Q280).
- `report-*.json`: delivery reports in **SiteLog's normalized shape** (`IletimerkeziReport` in
  `packages/shared/src/sms/iletimerkezi-report.ts`: `ready`, and per recipient `number`,
  `delivery` `pending` | `delivered` | `undelivered` | `unknown`, `code`), as served by the fixture
  endpoint (`ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT`). They are **not** the provider's format, which
  this repo does not know: once the owner has the report endpoint's documentation (§19 Q280), the
  real endpoint's parser maps the provider's answer to this shape, and its own tests add the
  provider's answers next to these.

| File                      | What the job does                                           |
| ------------------------- | ----------------------------------------------------------- |
| `report-delivered.json`   | `sent → delivered`                                          |
| `report-undelivered.json` | `sent → undeliverable`: fallback, or the office told once   |
| `report-pending.json`     | not final: the next poll (+15 min, +2 h)                    |
| `report-not-ready.json`   | the provider has no report yet: the next poll               |
| `report-unknown.json`     | a status the parser does not know: not final, the next poll |
