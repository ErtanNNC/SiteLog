/**
 * Whether SiteLog places automated calls for the reporter's org: the Field-02 box *Call me at
 * report time (automated)* asks the `auto_call` consent only then (spec §19 Q33: never while
 * nothing places calls). W3-17 (§19 Q51's first option, Q125, Q132): `resolve` answers
 * `placesCalls`: the org's pack has an outbound trunk in this environment, or the org is a demo
 * org whose calls ring the panel's Demo phone.
 */
export function placesAutomatedCalls(session: { placesCalls?: boolean }): boolean {
  return session.placesCalls === true;
}
