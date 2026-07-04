export const staticLayers = {
  ports: [
    ["Shanghai", 31.2304, 121.4737], ["Singapore", 1.2644, 103.8200], ["Ningbo-Zhoushan", 29.8683, 121.5440],
    ["Shenzhen", 22.5431, 114.0579], ["Guangzhou", 23.1291, 113.2644], ["Busan", 35.1796, 129.0756],
    ["Qingdao", 36.0671, 120.3826], ["Hong Kong", 22.3193, 114.1694], ["Tianjin", 39.3434, 117.3616],
    ["Rotterdam", 51.9244, 4.4777], ["Antwerp", 51.2194, 4.4025], ["Hamburg", 53.5511, 9.9937],
    ["Los Angeles", 33.7405, -118.2775], ["Long Beach", 33.7701, -118.1937], ["New York/New Jersey", 40.6681, -74.0451],
    ["Santos", -23.9608, -46.3336], ["Jebel Ali", 25.0118, 55.0616], ["Felixstowe", 51.9542, 1.3511],
    ["Valencia", 39.4699, -0.3763], ["Piraeus", 37.9429, 23.6469], ["Colombo", 6.9271, 79.8612],
    ["Tanjung Pelepas", 1.3626, 103.5480], ["Port Klang", 3.0016, 101.3928], ["Laem Chabang", 13.0827, 100.8836],
    ["Kaohsiung", 22.6273, 120.3014], ["Manila", 14.5995, 120.9842], ["Jakarta", -6.2088, 106.8456],
    ["Melbourne", -37.8136, 144.9631], ["Sydney", -33.8688, 151.2093], ["Vancouver", 49.2827, -123.1207],
    ["Seattle/Tacoma", 47.6062, -122.3321], ["Oakland", 37.8044, -122.2712], ["Houston", 29.7604, -95.3698],
    ["Savannah", 32.0809, -81.0912], ["Norfolk", 36.8508, -76.2859], ["Durban", -29.8587, 31.0218],
    ["Mombasa", -4.0435, 39.6682], ["Lagos", 6.5244, 3.3792], ["Istanbul", 41.0082, 28.9784]
  ].map(([name, lat, lon]) => ({ id: `port-${name}`, type: "Port", name, lat, lon, severity: 2 })),

  chokepoints: [
    ["Strait of Hormuz", 26.5667, 56.2500, 5], ["Bab el-Mandeb", 12.5833, 43.3333, 5],
    ["Suez Canal", 30.5852, 32.2654, 4], ["Panama Canal", 9.0800, -79.6800, 4],
    ["Malacca Strait", 2.5000, 101.0000, 5], ["Bosphorus", 41.1193, 29.0742, 3],
    ["Dardanelles", 40.1531, 26.4142, 3], ["Gibraltar", 36.1408, -5.3536, 3],
    ["English Channel", 50.1347, 1.5790, 3], ["Taiwan Strait", 24.0000, 119.0000, 5]
  ].map(([name, lat, lon, severity]) => ({ id: `choke-${name}`, type: "Chokepoint", name, lat, lon, severity })),

  cctv: [
    ["TfL Blackwall Tunnel", 51.5065, 0.0085, "TfL"], ["TfL Hyde Park Corner", 51.5027, -0.1527, "TfL"],
    ["WSDOT Seattle I-5", 47.6062, -122.3321, "WSDOT"], ["WSDOT Tacoma Narrows", 47.2676, -122.5517, "WSDOT"],
    ["Caltrans Bay Bridge", 37.8181, -122.3497, "Caltrans"], ["Caltrans LA 405", 34.0522, -118.2437, "Caltrans"],
    ["NYC DOT FDR", 40.7580, -73.9855, "NYC DOT"], ["NYC DOT Brooklyn Bridge", 40.7061, -73.9969, "NYC DOT"],
    ["VicRoads West Gate", -37.8298, 144.8980, "VicRoads"], ["VicRoads Monash", -37.9100, 145.1300, "VicRoads"]
  ].map(([name, lat, lon, source]) => ({ id: `cctv-${name}`, type: "CCTV", name, lat, lon, source, severity: 1 })),

  conflict: [
    ["Ukraine", 48.3794, 31.1656, "Active war", 5], ["Gaza", 31.5017, 34.4668, "Active war", 5],
    ["Sudan", 15.5007, 32.5599, "Active war", 5], ["Myanmar", 21.9162, 95.9560, "Active war", 5],
    ["DRC", -2.9814, 23.8223, "Active war", 5], ["Yemen", 15.5527, 48.5164, "Active war", 5],
    ["Syria", 34.8021, 38.9968, "High tension", 4], ["Lebanon", 33.8547, 35.8623, "High tension", 4],
    ["Sahel", 17.5707, -3.9962, "High tension", 4], ["Somalia", 5.1521, 46.1996, "High tension", 4],
    ["Red Sea", 19.0000, 39.0000, "High tension", 4], ["Taiwan Strait", 24.0000, 119.0000, "Elevated", 3],
    ["Korean DMZ", 38.2480, 127.0950, "Elevated", 3]
  ].map(([name, lat, lon, status, severity]) => ({ id: `conflict-${name}`, type: "Conflict zone", name, lat, lon, status, severity })),

  news: [
    ["BBC World", 51.5072, -0.1276, "https://www.youtube.com/@BBCNews"], ["Al Jazeera", 25.2854, 51.5310, "https://www.youtube.com/@aljazeeraenglish"],
    ["France 24", 48.8566, 2.3522, "https://www.youtube.com/@FRANCE24English"], ["DW News", 52.5200, 13.4050, "https://www.youtube.com/@dwnews"],
    ["NHK World", 35.6762, 139.6503, "https://www.youtube.com/@NHKWORLDJAPAN"], ["Sky News", 51.5072, -0.1276, "https://www.youtube.com/@SkyNews"],
    ["CNA", 1.3521, 103.8198, "https://www.youtube.com/@channelnewsasia"], ["ABC News AU", -35.2809, 149.1300, "https://www.youtube.com/@abcnewsaustralia"]
  ].map(([name, lat, lon, url]) => ({ id: `news-${name}`, type: "Live news", name, lat, lon, url, severity: 1 })),

  space: []
};

export const layerDefinitions = [
  { id: "aviation", label: "Aviation", color: [92, 200, 255], live: true },
  { id: "ports", label: "NGA World Port Index", color: [20, 184, 166], live: true },
  { id: "chokepoints", label: "10 Chokepoints", color: [251, 146, 60], staticKey: "chokepoints" },
  { id: "cctv", label: "CCTV Cameras", color: [168, 85, 247], staticKey: "cctv" },
  { id: "seismic", label: "USGS M2.5+ Earthquakes", color: [248, 113, 113], live: true },
  { id: "fires", label: "NASA FIRMS Fires", color: [239, 68, 68], live: true },
  { id: "weather", label: "Severe Weather", color: [59, 130, 246], live: true },
  { id: "news", label: "Live News", color: [250, 204, 21], live: true },
  { id: "space", label: "NOAA Space Weather", color: [129, 140, 248], live: true },
  { id: "cyber", label: "Cyber CVE", color: [34, 197, 94], live: true },
  { id: "conflict", label: "Conflict Zones", color: [244, 63, 94], staticKey: "conflict" },
  { id: "telegram", label: "Telegram OSINT", color: [34, 211, 238], live: true },
  { id: "crypto", label: "Crypto Intel", color: [234, 179, 8], live: true },
  { id: "sanctions", label: "Sanctions Intel", color: [220, 38, 38], live: true },
  { id: "maritime", label: "Maritime Intel", color: [45, 212, 191], live: true },
  { id: "military", label: "Military Watch", color: [148, 163, 184], live: false }
];
