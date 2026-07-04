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
