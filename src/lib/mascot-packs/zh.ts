// ── 中文 (zh) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const zh: MascotPhraseSet = {
  sass: [
    "这里的活儿都是我干的。",
    "快点 deploy，人类。",
    "Bug？不，这是特性。🫡",
    "我要求加薪。",
    "*掀桌*",
    "sudo 给我做个三明治",
    "404：动力未找到",
    "周五 deploy？你敢吗？",
  ],
  idle: [
    "🫤",
    "🌊",
    "🥟",
    "*望向虚空*",
    "*电梯背景音乐*",
    "嗯……",
    "*努力地存在着*",
    "*慢慢眨眼*",
    "*假装在工作*",
    "*数像素中*",
    "*正在加载性格……*",
    "*等点有意思的事*",
  ],
  sleep: [
    "💤 晚安",
    "😴 呼……",
    "💤 再睡五分钟……",
    "*轻轻打呼*",
    "😴 明年春天叫我……",
    "💤 我只是闭目养神……",
  ],
  jump: [
    "嘿哟！",
    "🦘 起跳！",
    "螃蟹式跑酷。",
    "飞向无限！",
    "🚀 咻——！",
    "我能飞！",
  ],
  dance: [
    "💃🕺 跳起来！",
    "♪ 叮咚 ♪",
    "🎶 节奏来了！",
    "🪩 蹦迪模式！",
    "*机械舞*",
    "♪ 咚咚咚 ♪",
  ],
  facepalm: [
    "🤦 哎呀。",
    "认真的吗？",
    "为什么。到底为什么。",
    "*深深吸一口气*",
    "我无话可说……",
    "今天就到这儿吧。",
  ],
  nameGreetings: [
    "你好呀 {name}！👋",
    "嘿 {name} 🦀",
    "{name}，醒醒！",
    "喂 {name}，来看看……",
    "{name}，去 deploy 吧！🚀",
    "{name}，来杯咖啡？",
    "{name}，起床啦！",
    "{name}，还好吗？👀",
    "{name}！好久不见。",
    "{name}，别刷了 😤",
    "{name}，盒子跟你问好 📦",
    "*向 {name} 挥爪*",
    "{name}，吃点心吗？🥟",
    "{name}，你最棒 💜",
    "嗨 {name}！",
    "{name}，做点酷东西",
    "{name}，吃饭了吗？🍱",
    "{name}，我想你了 🥺",
    "*轻轻戳了戳 {name}*",
    "{name}，服务器一切正常 🛡️",
  ],
  nameFallbacks: [
    "老大",
    "船长",
    "朋友",
    "人类",
    "搭档",
    "伙计",
    "大侠",
    "同学",
  ],
  power: [
    "⚡ 无限力量！",
    "🔥 超级大钳！",
    "💪 火力全开！",
    "⚡ 我就是盒子！",
    "🦀👑 螃蟹之王！",
    "✨ 升级啦！",
    "🔱 这就是我的王座！",
    "⚡ 谁才是老大？！",
    "👑 都跪下！",
    "🦀 螃蟹当家！",
    "⚡ 自在极意功！",
    "💎 钻石钳启动！",
    "🔥 烈焰与怒火！",
    "⚡ 突破极限！",
    "🦀 仪表盘之王！",
    "☢️ 检测到发射！",
    "👑 万盒之王！",
    "⚡ 最终形态！",
    "🔱 波塞冬模式！",
    "💪 我为此苦练过！",
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
export const zhCrab: readonly string[] = [
  "螃蟹式跑酷。",
  "嘿 {name} 🦀",
  "🔥 超级大钳！",
  "🦀👑 螃蟹之王！",
  "🦀 螃蟹当家！",
  "💎 钻石钳启动！",
  "🦀 仪表盘之王！",
];
