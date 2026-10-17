import type { Language } from '../locale.ts';

/**
 * Fallback clarification questions (spec §10.5, F7), used when the model proposed none for a gap:
 * in the reporter's language (EN, ES, TR, the field languages). The model's own `proposedQuestions`
 * are already in REPORTER_LOCALE (§10.4 rule 11) and win over these.
 *
 * D28: no fallback offers a number. A headcount question has no options (the field app shows a
 * number input with "full day" as the default hours, W1-13); the other options are words the
 * reporter taps ("Full day", "No stoppage"), each with the value code applies (`QuestionOption`).
 * English is the v1.0 WhatsApp wording, unchanged.
 */
export interface QuestionCopy {
  workersMissing(heard: string, area?: string): string;
  workersLowConfidence(heard: string, area?: string): string;
  hours(name: string): string;
  fullDay: string;
  halfDay: string;
  unknownCompany(heard: string): string;
  addCompany(name: string): string;
  mapCompany(name: string): string;
  weatherConditions: string;
  dryNoImpact: string;
  weatherImpact(condition: string): string;
  noStoppage: string;
  safety: string;
  noIncidents: string;
  toolboxTalkHeld: string;
  photo: string;
  sendingNow: string;
  noPhotoToday: string;
  /** The heard name when the crew has none. */
  theCrew: string;
  /** The company name when the crew has none. */
  thatCompany: string;
  /** The condition when the weather has none. */
  weather: string;
}

const en: QuestionCopy = {
  workersMissing: (heard, area) =>
    `Quick check: you said "${heard}"${area ? ` on ${area}` : ''}. How many, and for how long?`,
  workersLowConfidence: (heard, area) =>
    `Quick check: I heard "${heard}"${area ? ` on ${area}` : ''}. How many were there, and for how long?`,
  hours: (name) => `How long was ${name} on site today?`,
  fullDay: 'Full day',
  halfDay: 'Half day',
  unknownCompany: (heard) => `I heard "${heard}" — is that a new subcontractor?`,
  addCompany: (name) => `Add "${name}"`,
  mapCompany: (name) => `It's ${name}`,
  weatherConditions: 'What was the weather like today, and did it stop any work?',
  dryNoImpact: 'Dry, no impact',
  weatherImpact: (condition) => `You mentioned ${condition}. Did work stop, and for how long?`,
  noStoppage: 'No stoppage',
  safety: 'Any incidents or a toolbox talk today?',
  noIncidents: 'No incidents',
  toolboxTalkHeld: 'Toolbox talk held',
  photo: "A photo of today's work would complete the report. Can you send one?",
  sendingNow: 'Sending now',
  noPhotoToday: 'No photo today',
  theCrew: 'the crew',
  thatCompany: 'that company',
  weather: 'weather',
};

const es: QuestionCopy = {
  workersMissing: (heard, area) =>
    `Revisión rápida: dijo "${heard}"${area ? ` en ${area}` : ''}. ¿Cuántos eran y por cuánto tiempo?`,
  workersLowConfidence: (heard, area) =>
    `Revisión rápida: escuché "${heard}"${area ? ` en ${area}` : ''}. ¿Cuántos eran y por cuánto tiempo?`,
  hours: (name) => `¿Cuánto tiempo estuvo ${name} en la obra hoy?`,
  fullDay: 'Todo el día',
  halfDay: 'Medio día',
  unknownCompany: (heard) => `Escuché "${heard}". ¿Es un subcontratista nuevo?`,
  addCompany: (name) => `Agregar "${name}"`,
  mapCompany: (name) => `Es ${name}`,
  weatherConditions: '¿Cómo estuvo el clima hoy? ¿Detuvo algún trabajo?',
  dryNoImpact: 'Seco, sin impacto',
  weatherImpact: (condition) => `Mencionó ${condition}. ¿Se detuvo el trabajo? ¿Por cuánto tiempo?`,
  noStoppage: 'Sin paro',
  safety: '¿Hubo incidentes o una charla de seguridad hoy?',
  noIncidents: 'Sin incidentes',
  toolboxTalkHeld: 'Charla hecha',
  photo: 'Una foto del trabajo de hoy completaría el reporte. ¿Puede enviar una?',
  sendingNow: 'Enviando ahora',
  noPhotoToday: 'Sin foto hoy',
  theCrew: 'la cuadrilla',
  thatCompany: 'esa empresa',
  weather: 'el clima',
};

const tr: QuestionCopy = {
  workersMissing: (heard, area) =>
    `Kısa bir kontrol: "${heard}"${area ? ` (${area})` : ''} dediniz. Kaç kişiydiler, ne kadar çalıştılar?`,
  workersLowConfidence: (heard, area) =>
    `Kısa bir kontrol: "${heard}"${area ? ` (${area})` : ''} duydum. Kaç kişiydiler, ne kadar çalıştılar?`,
  hours: (name) => `${name} bugün sahada ne kadar kaldı?`,
  fullDay: 'Tam gün',
  halfDay: 'Yarım gün',
  unknownCompany: (heard) => `"${heard}" duydum. Bu yeni bir taşeron mu?`,
  addCompany: (name) => `"${name}" ekle`,
  mapCompany: (name) => `Bu ${name}`,
  weatherConditions: 'Bugün hava nasıldı, işi durdurdu mu?',
  dryNoImpact: 'Kuru, etkisi yok',
  weatherImpact: (condition) => `${condition} dediniz. İş durdu mu, ne kadar süre?`,
  noStoppage: 'Duruş yok',
  safety: 'Bugün bir olay oldu mu, iş güvenliği konuşması yapıldı mı?',
  noIncidents: 'Olay yok',
  toolboxTalkHeld: 'Konuşma yapıldı',
  photo: 'Bugünkü işin bir fotoğrafı raporu tamamlar. Gönderebilir misiniz?',
  sendingNow: 'Şimdi gönderiyorum',
  noPhotoToday: 'Bugün fotoğraf yok',
  theCrew: 'ekip',
  thatCompany: 'o firma',
  weather: 'hava',
};

export const QUESTION_COPY: Record<Language, QuestionCopy> = { en, es, tr };

/** The fallback questions in a field language (English for anything else). */
export function questionCopy(language: Language | string | null | undefined): QuestionCopy {
  const lang = (language ?? 'en').split('-')[0]!.toLowerCase();
  return lang === 'es' || lang === 'tr' ? QUESTION_COPY[lang] : en;
}
