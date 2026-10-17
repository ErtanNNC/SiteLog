import { applyCorrectionJob } from './apply_correction';
import { buildEvidencePack } from './build_evidence_pack';
import { decideNext } from './decide_next';
import { extractReport } from './extract_report';
import { fetchWeather } from './fetch_weather';
import { fileReportJob } from './file_report';
import { inboundMessage } from './inbound_message';
import { noPhotoCheckJob } from './no_photo_check';
import { notifyJob } from './notify';
import { parseAnswerJob } from './parse_answer';
import { parseReply } from './parse_reply';
import { placeCallJob } from './place_call';
import { postCallReconcileJob } from './post_call';
import { renderPdf } from './render_pdf';
import { retentionCleanup } from './retention_cleanup';
import { sendEmail } from './send_email';
import { sendMessage, sendTemplate } from './send_template';
import { sendWelcome } from './send_welcome';
import { deleteTestClipJob, transcribeTestClipJob } from './test_clip';
import { smsInbound } from './sms_inbound';
import { smsKeyword } from './sms_keyword';
import { smsStatusJob } from './sms_status';
import { transcribeAudioJob } from './transcribe_audio';
import { transcribeUploadJob } from './transcribe_upload';
import type { JobRegistry } from './types';
import { voiceTurnJob } from './voice_turn';
import { weeklyDigest } from './weekly_digest';
import { whatsappAnswerJob } from './whatsapp_answer';

/** One handler per JOB_TYPES entry (§10.1). */
export const registry: JobRegistry = {
  inbound_message: inboundMessage,
  sms_inbound: smsInbound,
  sms_keyword: smsKeyword,
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
  parse_answer: parseAnswerJob,
  transcribe_test_clip: transcribeTestClipJob,
  delete_test_clip: deleteTestClipJob,
  apply_correction: applyCorrectionJob,
  whatsapp_answer: whatsappAnswerJob,
  voice_turn: voiceTurnJob,
  post_call_reconcile: postCallReconcileJob,
  no_photo_check: noPhotoCheckJob,
  place_call: placeCallJob,
  sms_status: smsStatusJob,
};
