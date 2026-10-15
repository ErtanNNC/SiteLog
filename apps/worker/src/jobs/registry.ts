import { buildEvidencePack } from './build_evidence_pack';
import { decideNext } from './decide_next';
import { extractReport } from './extract_report';
import { fetchWeather } from './fetch_weather';
import { fileReportJob } from './file_report';
import { inboundMessage } from './inbound_message';
import { notifyJob } from './notify';
import { parseReply } from './parse_reply';
import { renderPdf } from './render_pdf';
import { retentionCleanup } from './retention_cleanup';
import { sendEmail } from './send_email';
import { sendMessage, sendTemplate } from './send_template';
import { sendWelcome } from './send_welcome';
import { smsInbound } from './sms_inbound';
import { transcribeAudioJob } from './transcribe_audio';
import { transcribeUploadJob } from './transcribe_upload';
import type { JobRegistry } from './types';
import { weeklyDigest } from './weekly_digest';

/** One handler per JOB_TYPES entry (§10.1). */
export const registry: JobRegistry = {
  inbound_message: inboundMessage,
  sms_inbound: smsInbound,
  transcribe_audio: transcribeAudioJob,
  transcribe_upload: transcribeUploadJob,
  extract_report: extractReport,
  decide_next: decideNext,
  parse_reply: parseReply,
  file_report: fileReportJob,
  render_pdf: renderPdf,
  send_email: sendEmail,
  fetch_weather: fetchWeather,
  send_welcome: sendWelcome,
  send_template: sendTemplate,
  send_message: sendMessage,
  build_evidence_pack: buildEvidencePack,
  retention_cleanup: retentionCleanup,
  weekly_digest: weeklyDigest,
  notify: notifyJob,
};
