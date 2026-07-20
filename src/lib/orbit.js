// Minimal two-body (Keplerian) orbit propagation — just enough to place a
// satellite's sub-point on the map from CelesTrak orbital elements, keyless and
// dependency-free. It is APPROXIMATE: it ignores J2, atmospheric drag, and the
// other perturbations a full SGP4 models, so positions drift from truth over
// time. Fed fresh CelesTrak epochs (updated several times a day) it is good to
// roughly a degree for LEO — fine for a situational dot, not precise tracking.
// N2YO stays the accurate path when a key is configured.

const MU = 398600.4418; // km^3/s^2, Earth's gravitational parameter
const EARTH_RADIUS_KM = 6378.137; // equatorial radius
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

// Greenwich Mean Sidereal Time (radians) — IAU 1982 series. Used to rotate the
// inertial position into an Earth-fixed longitude.
function gmst(dateMs) {
  const jd = dateMs / 86_400_000 + 2440587.5; // Julian date
  const d = jd - 2451545.0; // days since J2000.0
  const T = d / 36525.0;
  let deg = 280.46061837 + 360.98564736629 * d + T * T * (0.000387933 - T / 38710000);
  deg = ((deg % 360) + 360) % 360;
  return deg * DEG;
}

// Newton solve of Kepler's equation M = E - e·sinE for the eccentric anomaly.
function eccentricAnomaly(meanAnomaly, e) {
  let E = meanAnomaly;
  for (let i = 0; i < 12; i++) {
    const delta = (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
    E -= delta;
    if (Math.abs(delta) < 1e-10) break;
  }
  return E;
}

// Propagate the given orbital elements to `atMs` and return the sub-satellite
// point. Elements (from a CelesTrak GP record): epoch (ISO string), meanMotion
// (rev/day), eccentricity, and inclination/raan/argPerigee/meanAnomaly (degrees).
export function subSatellitePoint(el, atMs = Date.now()) {
  const n = (el.meanMotion * TWO_PI) / 86400; // mean motion, rad/s
  const a = Math.cbrt(MU / (n * n)); // semi-major axis, km
  const e = el.eccentricity;
  const inc = el.inclination * DEG;
  const raan = el.raan * DEG;
  const argp = el.argPerigee * DEG;

  // CelesTrak epochs are UTC but carry no timezone suffix; force UTC so a local
  // machine offset doesn't corrupt dt (a few hours' error scrambles the position).
  const epochMs = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(el.epoch) ? el.epoch : `${el.epoch}Z`);
  const dt = (atMs - epochMs) / 1000; // seconds since epoch
  const M = (((el.meanAnomaly * DEG + n * dt) % TWO_PI) + TWO_PI) % TWO_PI;
  const E = eccentricAnomaly(M, e);
  const nu = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e); // true anomaly
  const r = a * (1 - e * Math.cos(E)); // radius, km

  // Perifocal (PQW) position, then rotate to Earth-Centered Inertial via the
  // standard PQW->IJK matrix (Vallado) applied to (xp, yp, 0).
  const xp = r * Math.cos(nu);
  const yp = r * Math.sin(nu);
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = Math.cos(inc), si = Math.sin(inc);
  const cw = Math.cos(argp), sw = Math.sin(argp);

  const x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
  const y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
  const z = si * sw * xp + si * cw * yp;

  const rNorm = Math.sqrt(x * x + y * y + z * z);
  const lat = Math.asin(z / rNorm) / DEG;
  let lon = (Math.atan2(y, x) - gmst(atMs)) / DEG;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180; // normalize to [-180, 180]

  return { lat, lon, altKm: rNorm - EARTH_RADIUS_KM };
}

// Map a CelesTrak GP JSON record to the element shape subSatellitePoint expects.
export function elementsFromGp(gp) {
  return {
    epoch: gp.EPOCH,
    meanMotion: Number(gp.MEAN_MOTION),
    eccentricity: Number(gp.ECCENTRICITY),
    inclination: Number(gp.INCLINATION),
    raan: Number(gp.RA_OF_ASC_NODE),
    argPerigee: Number(gp.ARG_OF_PERICENTER),
    meanAnomaly: Number(gp.MEAN_ANOMALY)
  };
}
