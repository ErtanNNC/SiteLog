/**
 * The WhatsApp worker's reply grammar (v1.0) lives in `sms/replies.ts` since W2-12, next to the SMS
 * keywords; WhatsApp keeps importing it from here until step 22 retires the v1.0 path.
 */
export * from '../sms/replies.ts';
