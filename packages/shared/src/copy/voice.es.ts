import type { VoiceCatalog } from './voice.ts';

/**
 * The voice assistant's lines, Spanish (W3-01): the EN lines in Spanish, "usted" as the SMS copy
 * (§9.2 "Spanish versions mirror EN"); for the native-speaker read (§19 Q63).
 */
export const voiceEs: VoiceCatalog = {
  recording_notice: 'Esta llamada se graba para escribir su reporte diario.',
  opening_inbound:
    'TalkOlog, hola {first}. {recording_notice} Adelante con el reporte de hoy de {site}.',
  opening_inbound_pick_site: 'TalkOlog, hola {first}. {recording_notice}',
  opening_outbound:
    'Hola {first}, soy el asistente de TalkOlog para {company}. {recording_notice} ¿Está listo para darme el reporte de hoy de {site}?',
  opening_talk_now:
    'TalkOlog, hola {first}. {recording_notice} Adelante con el reporte de hoy de {site}.',
  go_ahead:
    'Adelante: qué se hizo, quién estuvo en la obra, el clima, las entregas y cualquier otra cosa.',
  pick_site: '¿Para qué obra es: {sites}?',
  pick_site_by_name: 'Diga el nombre de la obra.',
  or: 'o',
  backchannel: 'Ajá, siga.',
  filler: 'Entendido, un momento.',
  silence_prompt: '¿Sigue ahí?',
  silence_goodbye: 'Guardé lo que me dijo y le enviaré un enlace para terminar el reporte. Adiós.',
  time_warning: 'Nos quedan unos dos minutos de llamada.',
  fallback:
    'Hagámoslo de la forma más simple: dígame todo después del tono y cuelgue cuando termine.',
  readback_crew:
    'Esto es lo que tengo: {workers} en la obra de {companies} empresas, {hours} horas.',
  readback_crew_one_company:
    'Esto es lo que tengo: {workers} en la obra de una empresa, {hours} horas.',
  readback_weather: 'El clima detuvo el trabajo {hours} horas.',
  readback_change: 'Cambiado: {change}.',
  confirm_ask: '¿Lo registro?',
  confirm_repeat: '¿Lo registro? Diga sí o no.',
  weather_day_crew_ask:
    'Día de lluvia desde las {time}, el equipo se fue a casa. ¿Cuántos había en la obra esta mañana?',
  weather_photo_link: 'Una foto de las condiciones refuerza el registro. Le envié un enlace.',
  consent_ask:
    '¿Está bien si grabo estas llamadas y le envío enlaces de reportes por mensaje? Diga sí o no.',
  preference_ask: 'Cada día de trabajo, ¿prefiere una llamada o un mensaje con su enlace?',
  consent_declined: 'Entendido. No se guarda nada de esta llamada. Adiós.',
  consent_declined_link:
    'Entendido. No se guarda nada de esta llamada. Le enviaré su enlace por mensaje para que haga el reporte en la web. Adiós.',
  unknown_greeting: 'Hola, soy el asistente de TalkOlog.',
  unknown_caller:
    'Este número todavía no está en TalkOlog. Dígame su nombre, su empresa y la obra, y se lo pasaré a la oficina.',
  unknown_goodbye: 'Gracias, se lo pasaré a la oficina. Adiós.',
  goodbye_filed:
    'Registrado. Le envié el PDF y un enlace para agregar fotos. Que tenga buena tarde.',
  goodbye_draft_saved: 'Guardé su borrador y le enviaré un enlace para terminarlo. Adiós.',
  goodbye_no_work: 'Anotado: hoy no hay trabajo en {site}. Que tenga buena tarde.',
  goodbye_weather_day: 'Anotado: día perdido por el clima en {site}. Que tenga buena tarde.',
  goodbye_edit_applied: 'Listo. El reporte actualizado va a la oficina. Adiós.',
  goodbye_callback_requested: 'Está bien, le llamo a las {time}. Adiós.',
  goodbye_fallback_recording: 'Gracias. Le enviaré un enlace para revisar el borrador. Adiós.',
  goodbye_abandoned: 'Adiós.',
  pref_call_ok: 'Listo, su reporte diario ahora es por llamada.',
  pref_text_ok: 'Listo, su reporte diario ahora es por enlace en un mensaje.',
  load_report_summary: 'Reporte del {day}, {report_no}: {workers} en obra, {hours} horas.',
  load_report_found: 'Encontré el reporte del {day}, {report_no}.',
  still_working: 'Sigo en ello, un momento.',
  answer_crew: '{company}: {workers} trabajadores, {hours_each} horas cada uno — {hours} horas.',
  answer_crew_workers: '{company}: {workers} trabajadores.',
  answer_weather: 'Anotado: {hours} horas perdidas por el clima.',
  answer_no_stoppage: 'Anotado: el clima no detuvo el trabajo.',
  answer_company_added:
    'Anotado: {company}, un subcontratista nuevo que la oficina va a confirmar.',
  answer_company_mapped: 'Anotado: {company}.',
  answer_noted: 'Anotado.',
  answer_again: 'Perdón, no le entendí.',
  answer_skipped: 'No logré entenderlo, así que lo dejo para que la oficina lo revise.',
  readback_work: 'Hecho: {items}.',
  readback_work_complete: '{item} terminado',
  readback_work_percent: '{item} al {percent} por ciento más o menos',
  readback_work_count: 'Trabajos anotados: {count}.',
  readback_deliveries: 'Entregas: {items}.',
  readback_delivery_quantity: '{quantity} de {item}',
  readback_delivery_from: '{item} de {supplier}',
  readback_deliveries_count: 'Entregas anotadas: {count}.',
  readback_toolbox: 'Charla de seguridad.',
  readback_no_incidents: 'Sin incidentes.',
  readback_incident_one: 'Se reportó un incidente.',
  readback_incidents: 'Se reportaron {count} incidentes.',
  correction_crew_removed: '{company} quitado del reporte.',
  correction_unclear: 'Perdón, no pude hacer ese cambio. ¿Qué cambio?',
  correction_nothing: 'Eso ya lo tengo así.',
  day_off_confirm_no_work: '¿Hoy no hay trabajo en {site}? Diga sí o no.',
  day_off_confirm_weather:
    'Día perdido por el clima en {site}: el trabajo paró a las {time}, {hours} horas perdidas. ¿Lo registro?',
  day_off_confirm_weather_crew:
    'Día perdido por el clima en {site}: el trabajo paró a las {time}, había {workers} en obra, {hours} horas perdidas. ¿Lo registro?',
  day_off_confirm_never:
    'Día perdido por el clima en {site}: el equipo no llegó a empezar, {hours} horas perdidas. ¿Lo registro?',
  day_off_confirm_never_crew:
    'Día perdido por el clima en {site}: un equipo de {workers} no llegó a empezar, {hours} horas perdidas. ¿Lo registro?',
  day_off_confirm_repeat: '¿Lo registro? Diga sí o no.',
  day_off_logged_no_work: 'Registrado: hoy no hay trabajo en {site}.',
  day_off_logged_weather: 'Registrado: día perdido por el clima en {site}.',
  day_off_in_progress:
    'El reporte de hoy ya empezó, así que dígalo en el reporte: qué paró el trabajo y por cuánto tiempo.',
  day_off_filed: 'El reporte de hoy de {site} ya está archivado.',
  day_off_site_paused: '{site} está en pausa en TalkOlog. Pida a la oficina que la reactive.',
  callback_unavailable:
    'Todavía no puedo devolverle la llamada. Llame otra vez o use su enlace cuando esté listo.',
  callback_outside_window: 'Solo puedo llamar hasta las {time}. ¿Hacemos el reporte ahora?',
  callback_limit: 'Solo puedo devolverle la llamada una vez al día. ¿Hacemos el reporte ahora?',
  pref_not_today_ok: 'Está bien, hoy no le llamo más.',
  edit_ask: '¿Qué cambio?',
  edit_save_ask: '¿Lo guardo?',
  edit_save_repeat: '¿Lo guardo? Diga sí o no.',
  edit_saved: 'Guardado. La versión {version} va a la oficina.',
  edit_changed_meanwhile: 'El reporte cambió mientras hablábamos. Dígame el cambio otra vez.',
  edit_locked: 'Ese reporte está cerrado. Pida a la oficina que lo cambie.',
  edit_not_found: 'No encuentro un reporte archivado de ese día.',
  edit_ambiguous: 'Hay dos reportes ese día. ¿De qué obra es?',
  edit_pending: 'Todavía estoy con el último cambio, un momento.',
  consent_given: 'Gracias.',
  consent_repeat:
    'Perdón, ¿está bien que grabe estas llamadas y le envíe los enlaces de sus reportes por mensaje? Diga sí o no.',
  tool_error: 'Perdón, eso no funcionó de mi lado. Intentémoslo de nuevo.',
  test_call_greeting: 'Hola, soy el asistente de TalkOlog. Esta llamada no se graba.',
  test_call_line:
    'Esta es una llamada de prueba de TalkOlog para {company}. Su teléfono está listo para recibir llamadas de TalkOlog.',
  test_call_goodbye: 'Eso es todo para esta prueba. Adiós.',
};
