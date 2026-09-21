// ── 日本語 (ja) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const ja: MascotPhraseSet = {
  sass: [
    "ここの仕事、全部ぼくがやってる。",
    "もっと早く deploy して。",
    "Bug？いや、仕様です。🫡",
    "昇給を要求します。",
    "*ちゃぶ台をひっくり返す*",
    "sudo サンドイッチを作って",
    "404：やる気が見つかりません",
    "金曜に deploy？やってみる？",
  ],
  idle: [
    "🤨",
    "🌙",
    "🍵",
    "*虚空を見つめる*",
    "*エレベーターの音楽*",
    "うーん…",
    "*全力で存在中*",
    "*ゆっくりまばたき*",
    "*働いてるふり*",
    "*ピクセルを数える*",
    "*性格を読み込み中…*",
    "*何かおもしろいこと待ち*",
  ],
  sleep: [
    "💤 おやすみ",
    "😴 すやすや…",
    "💤 あと5分…",
    "*小さくいびき*",
    "😴 春になったら起こして…",
    "💤 目を休めてるだけ…",
  ],
  jump: [
    "それっ！",
    "🦘 ジャンプ！",
    "パルクール、カニ流。",
    "無限の彼方へ！",
    "🚀 ひゃっほー！",
    "ぼく、飛べる！",
  ],
  dance: [
    "💃🕺 踊ろう！",
    "♪ちゃんちゃん♪",
    "🎶 のってきた！",
    "🪩 ディスコモード！",
    "*ロボットダンス*",
    "♪ドンドンドン♪",
  ],
  facepalm: [
    "🤦 あちゃー。",
    "本気で？",
    "なんで。ほんとになんで。",
    "*深呼吸*",
    "言葉が出ない…",
    "今日は中止です。",
  ],
  nameGreetings: [
    "やあ {name}！👋",
    "おーい {name} 🦀",
    "{name}、起きて！",
    "ねえ {name}、ちょっと…",
    "{name}、deploy しよう！🚀",
    "コーヒーどう、{name}？",
    "{name}、朝だよ！",
    "{name}、元気？👀",
    "{name}！ひさしぶり。",
    "{name}、スクロールやめて 😤",
    "{name}、箱があいさつしてる 📦",
    "*{name} に手をふる*",
    "{name}、おやつ食べる？🍡",
    "{name}、さいこう 💜",
    "よっ、{name}！",
    "{name}、なにか作ろう",
    "ごはん食べた、{name}？🍱",
    "{name}、会いたかった 🥺",
    "*{name} をつつく*",
    "{name}、サーバーは元気だよ 🛡️",
  ],
  nameFallbacks: [
    "ボス",
    "船長",
    "相棒",
    "人間さん",
    "あなた",
    "先輩",
    "師匠",
    "大将",
  ],
  power: [
    "⚡ 無限のパワー！",
    "🔥 スーパーハサミ！",
    "💪 全力全開！",
    "⚡ ぼくが箱だ！",
    "🦀👑 カニの王！",
    "✨ レベルアップ！",
    "🔱 ここがぼくの玉座！",
    "⚡ ボスは誰だ？！",
    "👑 ひれ伏せ！",
    "🦀 カニ天下！",
    "⚡ 身勝手の極意！",
    "💎 ダイヤのハサミ！",
    "🔥 燃えてきた！",
    "⚡ 限界突破！",
    "🦀 ダッシュボードの王！",
    "☢️ 発射を検知！",
    "👑 すべての箱の王！",
    "⚡ 最終形態！",
    "🔱 ポセイドンモード！",
    "💪 このために鍛えた！",
  ],
};

// ── The crab-literal lines in this pack ──
//
// A Hermes pet wears someone else's body, so it must never say "crab", "claw"
// or wear the 🦀. `mascot-pet-voice.ts` subtracts this set from the pack
// before a pet speaks; the crab itself is served the pack untouched.
//
// Tagged HERE, next to the lines themselves, so adding a joke and declaring it
// crab-specific is one edit in one file — and so a locale's tags travel in the
// same code-split chunk as its pack. `mascot-pet-voice.test.ts` re-derives
// this list from a crab lexicon and fails if the two disagree, which is what
// stops it drifting.
export const jaCrab: readonly string[] = [
  "パルクール、カニ流。",
  "おーい {name} 🦀",
  "🔥 スーパーハサミ！",
  "🦀👑 カニの王！",
  "🦀 カニ天下！",
  "💎 ダイヤのハサミ！",
  "🦀 ダッシュボードの王！",
];
