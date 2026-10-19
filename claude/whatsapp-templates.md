# WhatsApp şablonları (Twilio Content Template Builder)

Kaynak: `pnpm countries:set -- --code US --print-whatsapp-templates` (preview, 2026-10-19). Her satırı Twilio'da **Utility** türünde ayrı bir şablon olarak gönderin. `{{1}}`, `{{2}}` numaralarını değiştirmeyin. Meta onaylayınca her şablonun `HX…` kimliğini bana yazın; `countries-set` ile işlerim.

Önerilen şablon adı: `talkolog_<anahtar>_<dil>` (örnek `talkolog_daily_link_en`).

## US paketi (EN, ES)

| Anahtar         | Dil | Değişkenler                  | Metin                                                                                                       |
| --------------- | --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| daily_link      | en  | 1=site, 2=link               | Today's report for {{1}}: {{2}} - TalkOlog                                                                  |
| daily_link      | es  | 1=site, 2=link               | Reporte de hoy para {{1}}: {{2}} - TalkOlog                                                                 |
| call_coming     | en  | 1=time, 2=link               | I'll call you at {{1}} for today's report. Prefer to do it now? {{2}} - TalkOlog                            |
| call_coming     | es  | 1=time, 2=link               | Le llamaré a las {{1}} para el reporte de hoy. ¿Prefiere hacerlo ahora? {{2}} - TalkOlog                    |
| weather_headsup | en  | 1=deadline, 2=weather_phrase | Heads-up: report due at {{1}}. {{2}} - mention the hours lost and what stopped.                             |
| weather_headsup | es  | 1=deadline, 2=weather_phrase | Aviso: el reporte se entrega a las {{1}}. {{2}} - mencione las horas perdidas y qué trabajos se detuvieron. |
| reminder_1      | en  | 1=site, 2=link               | No report yet for {{1}} today. A one-minute voice note is plenty: {{2}} - TalkOlog                          |
| reminder_1      | es  | 1=site, 2=link               | Todavía no hay reporte de {{1}} hoy. Una nota de voz de un minuto es suficiente: {{2}} - TalkOlog           |
| reminder_2      | en  | 1=time, 2=link               | Still nothing for today. I'll let the office know at {{1}}. {{2}} - TalkOlog                                |
| reminder_2      | es  | 1=time, 2=link               | Todavía nada para hoy. Le avisaré a la oficina a las {{1}}. {{2}} - TalkOlog                                |
| missed_call     | en  | 1=link                       | Missed you for today's report. Tap {{1}}.                                                                   |
| missed_call     | es  | 1=link                       | No pude comunicarme con usted para el reporte de hoy. Toque {{1}}.                                          |
| question_ready  | en  | 1=link                       | One quick question about today's report: {{1}} - TalkOlog                                                   |
| question_ready  | es  | 1=link                       | Una pregunta rápida sobre el reporte de hoy: {{1}} - TalkOlog                                               |
| draft_ready     | en  | 1=link                       | Your report is ready to check: {{1}} - TalkOlog                                                             |
| draft_ready     | es  | 1=link                       | Su reporte está listo para revisar: {{1}} - TalkOlog                                                        |
| filed           | en  | 1=report_no, 2=pdf_link      | Filed: Daily Report {{1}}. PDF: {{2}} - TalkOlog                                                            |
| filed           | es  | 1=report_no, 2=pdf_link      | Registrado: Reporte diario {{1}}. PDF: {{2}} - TalkOlog                                                     |
| photos_link     | en  | 1=link                       | Add photos to today's report: {{1}} - TalkOlog                                                              |
| photos_link     | es  | 1=link                       | Agregue fotos al reporte de hoy: {{1}} - TalkOlog                                                           |
| edit_applied    | en  | 1=weekday, 2=change, 3=v     | Updated {{1}}: {{2}}. Version {{3}} sent to the office.                                                     |
| edit_applied    | es  | 1=weekday, 2=change, 3=v     | Reporte del {{1}} actualizado: {{2}}. Versión {{3}} enviada a la oficina.                                   |
| finish_report   | en  | 1=link                       | Your call ended before filing. Finish in one tap: {{1}} - TalkOlog                                          |
| finish_report   | es  | 1=link                       | Su llamada terminó antes de registrar el reporte. Termínelo con un toque: {{1}} - TalkOlog                  |
| site_paused     | en  | 1=site                       | TalkOlog: {{1}} is paused in TalkOlog. Ask the office to resume it.                                         |
| site_paused     | es  | 1=site                       | TalkOlog: {{1}} está en pausa en TalkOlog. Pida a la oficina que reactive la obra.                          |

Onaylanınca bana şu biçimde verin (eksik olanlar SMS ile gider):

```json
{ "daily_link": { "en": "HX…", "es": "HX…" }, "reminder_1": { "en": "HX…", "es": "HX…" } }
```

TR şablonları da hazır (`--code TR`), ama TR paketi bu numarayı kullanamıyor: `claude/STATUS.md`, 2026-10-19 Twilio girişi.
