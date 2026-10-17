/**
 * Whether SiteLog places automated calls for the reporter's pack: the Field-02 box *Call me at
 * report time (automated)* asks the `auto_call` consent only then (spec §19 Q33: no `auto_call`
 * consent while the pack has no outbound trunk). Outbound calls are M8 and the trunks are env
 * (`LIVEKIT_SIP_OUTBOUND_TRUNKS`, §19 Q38), which `resolve` does not report, so no pack places
 * them in week 1; how the app learns it from M8 is spec §19 Q51.
 */
export function placesAutomatedCalls(_pack: { voiceNumber: string | null }): boolean {
  return false;
}
