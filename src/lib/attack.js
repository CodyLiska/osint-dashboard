// CWE → MITRE ATT&CK (Enterprise) technique tagging for the cyber layer.
//
// There is no keyless, comprehensive CVE→ATT&CK feed: MITRE's ATT&CK STIX data is
// the technique catalog (no CVE rows), and the Center for Threat-Informed Defense
// CVE→ATT&CK mappings cover only a few thousand CVEs. What NVD *does* give per CVE
// is its CWE weakness class, and the weakness→technique relationship is stable and
// well understood. So we tag heuristically: CVE → CWE (from NVD) → ATT&CK technique
// via the curated table below. This is a *weakness-derived* mapping, not a per-CVE
// analyst mapping — it says "a flaw of this class is typically exploited via this
// technique", which is exactly the situational-awareness signal the dashboard wants.
// It is deliberately hand-curated (no upstream to regenerate from) and covers the
// CWEs that actually recur in KEV/NVD; an unmapped CWE simply yields no tag.

// The technique catalog: id → display name + the primary ATT&CK tactic. Only the
// techniques referenced below are listed.
export const TECHNIQUES = {
  T1190: { name: "Exploit Public-Facing Application", tactic: "Initial Access" },
  T1059: { name: "Command and Scripting Interpreter", tactic: "Execution" },
  T1203: { name: "Exploitation for Client Execution", tactic: "Execution" },
  T1068: { name: "Exploitation for Privilege Escalation", tactic: "Privilege Escalation" },
  T1078: { name: "Valid Accounts", tactic: "Initial Access" },
  T1189: { name: "Drive-by Compromise", tactic: "Initial Access" },
  "T1505.003": { name: "Web Shell", tactic: "Persistence" },
  T1499: { name: "Endpoint Denial of Service", tactic: "Impact" },
  T1574: { name: "Hijack Execution Flow", tactic: "Persistence" }
};

// Curated CWE → technique(s). Keys are the CWE ids NVD emits ("CWE-89"); values are
// technique ids present in TECHNIQUES above.
export const CWE_TO_TECHNIQUE = {
  "CWE-78": ["T1059"],    // OS command injection
  "CWE-77": ["T1059"],    // command injection
  "CWE-94": ["T1059"],    // code injection
  "CWE-89": ["T1190"],    // SQL injection
  "CWE-79": ["T1189"],    // cross-site scripting
  "CWE-352": ["T1189"],   // cross-site request forgery
  "CWE-22": ["T1190"],    // path traversal
  "CWE-434": ["T1505.003"], // unrestricted file upload → web shell
  "CWE-502": ["T1190"],   // deserialization of untrusted data
  "CWE-611": ["T1190"],   // XML external entity
  "CWE-918": ["T1190"],   // server-side request forgery
  "CWE-787": ["T1203"],   // out-of-bounds write
  "CWE-125": ["T1203"],   // out-of-bounds read
  "CWE-416": ["T1203"],   // use after free
  "CWE-119": ["T1203"],   // improper restriction of memory buffer
  "CWE-120": ["T1203"],   // classic buffer overflow
  "CWE-190": ["T1203"],   // integer overflow
  "CWE-476": ["T1499"],   // NULL pointer dereference → DoS
  "CWE-400": ["T1499"],   // uncontrolled resource consumption
  "CWE-287": ["T1078"],   // improper authentication
  "CWE-306": ["T1190"],   // missing authentication for critical function
  "CWE-798": ["T1078"],   // use of hard-coded credentials
  "CWE-269": ["T1068"],   // improper privilege management
  "CWE-264": ["T1068"],   // permissions, privileges, and access controls
  "CWE-284": ["T1190"],   // improper access control
  "CWE-862": ["T1190"],   // missing authorization
  "CWE-863": ["T1190"],   // incorrect authorization
  "CWE-427": ["T1574"],   // uncontrolled search path element (DLL/lib hijack)
  "CWE-20": ["T1190"]     // improper input validation
};

// Deep-link to a technique's ATT&CK page. Sub-techniques ("T1505.003") live under
// their parent: /techniques/T1505/003/.
export function attackUrl(id) {
  const [base, sub] = String(id).split(".");
  return sub
    ? `https://attack.mitre.org/techniques/${base}/${sub}/`
    : `https://attack.mitre.org/techniques/${base}/`;
}

// Pull the CWE ids out of an NVD CVE object. NVD 2.0 nests them under
// weaknesses[].description[] as { lang, value: "CWE-89" }; "NVD-CWE-noinfo" /
// "NVD-CWE-Other" placeholders carry no class and are dropped.
export function cwesFromCve(cve) {
  const out = new Set();
  for (const weakness of cve?.weaknesses || []) {
    for (const desc of weakness?.description || []) {
      const value = String(desc?.value || "");
      if (/^CWE-\d+$/.test(value)) out.add(value);
    }
  }
  return [...out];
}

// Map a list of CWE ids to a deduped list of technique tags, each
// { id, name, tactic, url }. CWEs with no curated mapping contribute nothing.
export function techniquesForCwes(cweIds) {
  const seen = new Set();
  const out = [];
  for (const cwe of cweIds || []) {
    for (const id of CWE_TO_TECHNIQUE[cwe] || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = TECHNIQUES[id];
      out.push({ id, name: t?.name || id, tactic: t?.tactic || null, url: attackUrl(id) });
    }
  }
  return out;
}
