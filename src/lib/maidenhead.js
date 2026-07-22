// Maidenhead grid locator → lat/lon of the square's CENTER. Used by the SIGINT
// layers (PSKReporter reports a receiver's grid, not its coordinates). Supports
// 4-char (field+square, ~1°×2°) and 6-char (+subsquare, ~2.5'×5') locators.
//
// Encoding: field  = 2 letters A-R  (18 × 18, each 10° lat × 20° lon)
//           square = 2 digits 0-9   (each 1° lat × 2° lon)
//           sub    = 2 letters A-X   (each 1/24° lat × 2/24° lon)
export function gridToLatLon(grid) {
  const g = String(grid || "").trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  const A = "A".charCodeAt(0);

  let lon = (g.charCodeAt(0) - A) * 20 - 180 + Number(g[2]) * 2;
  let lat = (g.charCodeAt(1) - A) * 10 - 90 + Number(g[3]);

  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - A) * (2 / 24) + (2 / 24) / 2; // + subsquare, centered
    lat += (g.charCodeAt(5) - A) * (1 / 24) + (1 / 24) / 2;
  } else {
    lon += 1;   // center of the 2° square
    lat += 0.5; // center of the 1° square
  }
  return { lat, lon };
}
