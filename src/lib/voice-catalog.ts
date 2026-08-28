/**
 * What the Voice tab can offer: the voices each engine really has, and the
 * languages the sample sentence comes in.
 *
 * Pure data, importable from the browser. The on-device list is the allowlist
 * `scripts/openclaw/clawbox-tts.sh` accepts (`--list-voices`); the cloud list
 * is what OpenClaw's OpenAI speech provider validates against. A voice that is
 * not in these lists is refused by the engine, so offering it would be a
 * dropdown entry that silently speaks with something else.
 */

export interface VoiceOption {
  id: string;
  label: string;
}

/** Kokoro voices the local script accepts, named for people. English only. */
export const LOCAL_VOICES: readonly VoiceOption[] = [
  { id: "af_heart", label: "Heart — female, American" },
  { id: "af_bella", label: "Bella — female, American" },
  { id: "am_adam", label: "Adam — male, American" },
  { id: "am_michael", label: "Michael — male, American" },
  { id: "bf_emma", label: "Emma — female, British" },
  { id: "bm_george", label: "George — male, British" },
];

export const DEFAULT_LOCAL_VOICE = "af_heart";

/** The OpenAI-compatible voices the ClawBox AI cloud speaks with. Any language. */
export const CLOUD_VOICES: readonly VoiceOption[] = [
  { id: "alloy", label: "Alloy — neutral" },
  { id: "ash", label: "Ash — male, warm" },
  { id: "ballad", label: "Ballad — male, soft" },
  { id: "coral", label: "Coral — female, bright" },
  { id: "echo", label: "Echo — male, calm" },
  { id: "fable", label: "Fable — British, expressive" },
  { id: "nova", label: "Nova — female, friendly" },
  { id: "onyx", label: "Onyx — male, deep" },
  { id: "sage", label: "Sage — female, calm" },
  { id: "shimmer", label: "Shimmer — female, clear" },
  { id: "verse", label: "Verse — male, expressive" },
];

export const DEFAULT_CLOUD_VOICE = "alloy";

/**
 * Voices only the newer speech model has. `tts-1` and `tts-1-hd` refuse
 * `ballad` and `verse` with a 400, so a box whose cloud provider is pinned to
 * one of those must not be offered them — that would be a dropdown entry that
 * plays an error.
 */
const NEWER_MODEL_ONLY_VOICES: ReadonlySet<string> = new Set(["ballad", "verse"]);

/** The models with the smaller voice list. Anything else — `gpt-4o-mini-tts`,
 *  a model this catalogue has never heard of, or none configured — gets the
 *  full list, because refusing a voice a model may well have is the worse
 *  mistake. */
export function isLegacyCloudModel(model: string | null | undefined): boolean {
  const id = (model ?? "").trim().toLowerCase();
  return id === "tts-1" || id === "tts-1-hd";
}

/** The cloud voices a given model accepts. */
export function cloudVoicesFor(model: string | null | undefined): readonly VoiceOption[] {
  return isLegacyCloudModel(model) ? CLOUD_VOICES.filter((v) => !NEWER_MODEL_ONLY_VOICES.has(v.id)) : CLOUD_VOICES;
}

export function isLocalVoice(value: unknown): value is string {
  return typeof value === "string" && LOCAL_VOICES.some((v) => v.id === value);
}

/** A cloud voice SOME model has. For "this model has it", see isCloudVoiceFor. */
export function isCloudVoice(value: unknown): value is string {
  return typeof value === "string" && CLOUD_VOICES.some((v) => v.id === value);
}

/** A cloud voice the configured model will actually speak with. */
export function isCloudVoiceFor(model: string | null | undefined, value: unknown): value is string {
  return typeof value === "string" && cloudVoicesFor(model).some((v) => v.id === value);
}

export interface VoiceLanguage {
  id: string;
  label: string;
  /** A medium sentence the owner can hear before typing their own. */
  sample: string;
}

/** The languages the desktop speaks, each with a sample in its own words. */
export const VOICE_LANGUAGES: readonly VoiceLanguage[] = [
  { id: "en", label: "English", sample: "Hello! I'm your ClawBox assistant. I can read your messages aloud, remind you about your day, and answer questions whenever you need me." },
  { id: "de", label: "Deutsch", sample: "Hallo! Ich bin dein ClawBox-Assistent. Ich kann dir Nachrichten vorlesen, dich an deinen Tag erinnern und Fragen beantworten, wann immer du mich brauchst." },
  { id: "es", label: "Español", sample: "¡Hola! Soy tu asistente ClawBox. Puedo leerte los mensajes en voz alta, recordarte tu día y responder preguntas siempre que me necesites." },
  { id: "fr", label: "Français", sample: "Bonjour ! Je suis votre assistant ClawBox. Je peux lire vos messages à voix haute, vous rappeler votre journée et répondre à vos questions dès que vous avez besoin de moi." },
  { id: "it", label: "Italiano", sample: "Ciao! Sono il tuo assistente ClawBox. Posso leggerti i messaggi ad alta voce, ricordarti la tua giornata e rispondere alle domande ogni volta che hai bisogno di me." },
  { id: "ja", label: "日本語", sample: "こんにちは！私はあなたのClawBoxアシスタントです。メッセージを読み上げたり、今日の予定をお知らせしたり、いつでも質問にお答えします。" },
  { id: "nl", label: "Nederlands", sample: "Hallo! Ik ben je ClawBox-assistent. Ik kan je berichten voorlezen, je aan je dag herinneren en vragen beantwoorden wanneer je me nodig hebt." },
  { id: "sv", label: "Svenska", sample: "Hej! Jag är din ClawBox-assistent. Jag kan läsa upp dina meddelanden, påminna dig om din dag och svara på frågor när du än behöver mig." },
  { id: "zh", label: "中文", sample: "你好！我是你的 ClawBox 助手。我可以为你朗读消息，提醒你今天的安排，并随时回答你的问题。" },
  { id: "bg", label: "Български", sample: "Здравей! Аз съм твоят асистент ClawBox. Мога да чета съобщенията ти на глас, да ти напомням за деня и да отговарям на въпроси винаги, когато имаш нужда от мен." },
];

export const DEFAULT_VOICE_LANGUAGE = "en";

export function isVoiceLanguage(value: unknown): value is string {
  return typeof value === "string" && VOICE_LANGUAGES.some((l) => l.id === value);
}

export function sampleSentence(language: string): string {
  return (VOICE_LANGUAGES.find((l) => l.id === language) ?? VOICE_LANGUAGES[0]).sample;
}

/** The most text one "hear it" request may speak. Long enough for a paragraph, short enough to stay a sample. */
export const SAMPLE_MAX_CHARS = 400;
