import { translations } from "../src/lib/translations";

const locales = Object.keys(translations) as (keyof typeof translations)[];

// Keys whose value is intentionally the same in every locale: brand names,
// labels that everyone uses in English, or strings dominated by code/punctuation.
const ALLOWED_IDENTICAL = new Set<string>([
  "brand", "appName",
]);

// Substrings that strongly suggest a string SHOULDN'T be translated
// (URLs, code, brand names, single ascii chars, numbers).
function looksLikeProperNounOrCode(s: string): boolean {
  // Brand-only strings or things that contain no letters at all.
  if (!/[a-zA-Z]/.test(s)) return true;
  // Contains a URL.
  if (/https?:\/\//.test(s)) return false; // could still need translating around the URL
  // Pure brand names commonly kept verbatim
  if (/^(ClawBox|ClawKeep|OpenClaw|ClawHub|Telegram|Discord|WhatsApp|Slack|Signal|Ollama|Claude|GPT|Gemini|OpenRouter|GitHub|VS Code|VNC|Chromium|Firefox|Chrome|Wifi|WiFi|Bluetooth|Tegra)$/.test(s)) return true;
  return false;
}

let totalSuspicious = 0;
const PER_LOCALE_SAMPLE = 30;

for (const loc of locales) {
  if (loc === "en") continue;
  const enT = translations.en;
  const locT = translations[loc];
  const same: { key: string; value: string }[] = [];
  for (const k of Object.keys(enT)) {
    const ev = enT[k];
    const lv = locT[k];
    if (lv === undefined) continue;
    if (ev === lv && !ALLOWED_IDENTICAL.has(k) && !looksLikeProperNounOrCode(ev)) {
      same.push({ key: k, value: ev });
    }
  }
  if (same.length === 0) {
    console.log(`=== ${loc}: ✅ no suspicious identical-to-English values ===`);
    continue;
  }
  totalSuspicious += same.length;
  console.log(`=== ${loc}: ${same.length} suspicious identical-to-English values ===`);
  for (const { key, value } of same.slice(0, PER_LOCALE_SAMPLE)) {
    const truncVal = value.length > 80 ? value.slice(0, 77) + "..." : value;
    console.log(`    ${key}: "${truncVal}"`);
  }
  if (same.length > PER_LOCALE_SAMPLE) console.log(`    ... and ${same.length - PER_LOCALE_SAMPLE} more`);
}
console.log(`\nTOTAL suspicious: ${totalSuspicious}`);
