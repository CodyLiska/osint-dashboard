// The shared entity shape every adapter returns.
//
// ---- The `severity` contract ----
// severity is a number 1-5 meaning ONE thing across every layer: how bad this
// event is. Most layers emit whole numbers; a layer whose source is a continuous
// measure may emit a fraction (seismic passes USGS magnitude straight through,
// so 2.72 is a real value). Comparisons that need a discrete grade — the history
// store, escalation — round; the filter compares directly and does not care. It is the axis the cross-layer severity filter sorts on, the axis
// the Live Desk ranks by, and the axis alert rules threshold on — so a 4 must
// mean roughly the same thing whether it came from USGS or GDACS.
//
//   5  critical      severe, acting-now impact
//   4  high          significant impact
//   3  moderate      notable, routine-response
//   2  low           minor / informational with a location
//   1  background    reference or baseline presence
//
// Two things severity is NOT, both of which have been got wrong here before:
//   - NOT lifecycle stage. Whether an event is new, ongoing, or finished belongs
//     in `status`. Encoding stage as severity makes an event "de-escalate" as it
//     matures, which corrupts both the filter and escalation alerting.
//   - NOT confidence. How sure we are of the geolocation is `confidence`.
//
// A constant severity is legitimate when a layer has no impact axis (every entry
// is equivalent). Where that is the case, say so in a comment at the constant,
// because a constant silently makes any rule with a higher threshold unmatchable.
export function entity(fields) {
  return {
    ...fields,
    id: fields.id,
    layer: fields.layer,
    type: fields.type || fields.layer,
    name: fields.name || fields.id,
    lat: Number(fields.lat),
    lon: Number(fields.lon),
    severity: Number(fields.severity || 1),
    time: fields.time || null,
    source: fields.source || null,
    url: fields.url || null
  };
}

export function finiteCoordinate(row) {
  return Number.isFinite(row.lat) && Number.isFinite(row.lon);
}
