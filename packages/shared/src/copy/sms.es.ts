import type { SmsCatalog, SmsKey } from './sms.ts';

/**
 * §9.2 SMS copy, Spanish (US reporters): mirrors the English texts in Latin American Spanish as
 * spoken on US job sites. Formal "usted" (the same across Latin America, and the register of an
 * assistant writing to a site manager); "reporte", "enlace", "obra". The SMS keywords STOP, HELP,
 * START, CALL and TEXT stay in English because `sms-webhook` matches them (§9.5). Accents force
 * UCS-2 (70 code units per segment), so the texts without variables are kept to 70 units: one
 * segment, like their GSM-7 English versions. The welcome's reply clause is `smsReplyHintEs`,
 * appended by `renderSms` only for packs with two-way SMS. Punctuation is GSM-7 only (spec §19 Q15):
 * only accented letters take a text out of GSM-7.
 */
export const smsEs: SmsCatalog<SmsKey> = {
  welcome: {
    withNumber:
      'Hola {first}, soy SiteLog, el asistente de reportes diarios de {company} en {site}. Cada día de trabajo antes de las {deadline}, toque su enlace y hable unos 3 min, o llame al {number}: {link}',
    withoutNumber:
      'Hola {first}, soy SiteLog, el asistente de reportes diarios de {company} en {site}. Cada día de trabajo antes de las {deadline}, toque su enlace y hable unos 3 min: {link}',
  },
  verify_code: 'Su código de SiteLog: {code}. Vence en 10 minutos.',
  daily_link: {
    withNumber: 'Reporte de hoy para {site}: {link} - o simplemente llame al {number}.',
    withoutNumber: 'Reporte de hoy para {site}: {link}',
  },
  call_coming: 'Le llamaré a las {time} para el reporte de hoy. ¿Prefiere hacerlo ahora? {link}',
  weather_headsup:
    'Aviso: el reporte se entrega a las {deadline}. {weather_phrase} - mencione las horas perdidas y qué trabajos se detuvieron.',
  reminder_1:
    'Todavía no hay reporte de {site} hoy. Una nota de voz de un minuto es suficiente: {link}',
  reminder_2: {
    withNumber:
      'Todavía nada para hoy. Le avisaré a la oficina a las {time}. {link} o llame al {number}.',
    withoutNumber: 'Todavía nada para hoy. Le avisaré a la oficina a las {time}. {link}',
  },
  missed_call: {
    withNumber:
      'No pude comunicarme con usted para el reporte de hoy. Llame al {number} o toque {link}.',
    withoutNumber: 'No pude comunicarme con usted para el reporte de hoy. Toque {link}.',
  },
  question_ready: 'Una pregunta rápida sobre el reporte de hoy: {link}',
  draft_ready: 'Su reporte está listo para revisar: {link}',
  filed: 'Registrado: Reporte diario {report_no}. PDF: {pdf_link}',
  photos_link: 'Agregue fotos al reporte de hoy: {link}',
  edit_applied: 'Reporte del {weekday} actualizado: {change}. Versión {v} enviada a la oficina.',
  finish_report: 'Su llamada terminó antes de registrar el reporte. Termínelo con un toque: {link}',
  site_paused: '{site} está en pausa en SiteLog. Pida a la oficina que reactive la obra.',
  unknown_number: 'Este número no está en SiteLog. Pida a su oficina que lo agregue.',
  help: {
    withNumber:
      'Reportes diarios de SiteLog para {company}. Su enlace: {link} - Llame al {number} - Envíe CALL o TEXT para elegir llamada o mensaje - STOP para darse de baja. Pueden aplicarse cargos por mensajes y datos.',
    withoutNumber:
      'Reportes diarios de SiteLog para {company}. Su enlace: {link} - Envíe CALL o TEXT para elegir llamada o mensaje - STOP para darse de baja. Pueden aplicarse cargos por mensajes y datos.',
  },
  stop_confirm: 'Ya no recibirá mensajes de SiteLog. Responda START para reactivarlos.',
  // No accents, so GSM-7: one segment each (spec §19 Q46).
  pref_call_ok:
    'Listo, su reporte diario ahora es por llamada. Responda TEXT para cambiar a un enlace.',
  pref_text_ok:
    'Listo, su reporte diario ahora es por enlace en un mensaje. Responda CALL para cambiar a una llamada.',
};

/** The `welcome` reply clause for packs with two-way SMS (mirrors `smsReplyHintEn`). */
export const smsReplyHintEs = ' - Responda STOP para darse de baja, HELP para ayuda';
