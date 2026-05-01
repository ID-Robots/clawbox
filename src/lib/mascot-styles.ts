// Mascot keyframe animations. Pulled out of `Mascot.tsx` so the component
// file can focus on stateful React logic — these are static and never change
// at runtime.

export const MASCOT_KEYFRAMES = `
@keyframes mascot-waddle {
  0% { transform: translateY(0) rotate(0deg) scaleX(1); }
  10% { transform: translateY(-6px) rotate(-6deg) scaleX(0.95); }
  20% { transform: translateY(-2px) rotate(-3deg) scaleX(1); }
  30% { transform: translateY(-8px) rotate(0deg) scaleX(0.95); }
  40% { transform: translateY(-2px) rotate(3deg) scaleX(1); }
  50% { transform: translateY(-6px) rotate(6deg) scaleX(0.95); }
  60% { transform: translateY(-2px) rotate(3deg) scaleX(1); }
  70% { transform: translateY(-8px) rotate(0deg) scaleX(0.95); }
  80% { transform: translateY(-2px) rotate(-3deg) scaleX(1); }
  90% { transform: translateY(-6px) rotate(-6deg) scaleX(0.95); }
  100% { transform: translateY(0) rotate(0deg) scaleX(1); }
}
@keyframes mascot-idle {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-2px) rotate(1deg); }
}
@keyframes mascot-thinking {
  0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
  20% { transform: translateY(-4px) rotate(-3deg) scale(1.02); }
  40% { transform: translateY(-2px) rotate(3deg) scale(1); }
  60% { transform: translateY(-6px) rotate(-2deg) scale(1.03); }
  80% { transform: translateY(-3px) rotate(2deg) scale(1.01); }
}
@keyframes mascot-celebrate {
  0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
  25% { transform: translateY(-12px) rotate(-12deg) scale(1.15); }
  50% { transform: translateY(-18px) rotate(0deg) scale(1.2); }
  75% { transform: translateY(-12px) rotate(12deg) scale(1.15); }
}
@keyframes mascot-sleep {
  0%, 100% { transform: translateY(0) rotate(8deg) scale(0.95); }
  50% { transform: translateY(3px) rotate(12deg) scale(0.93); }
}
@keyframes mascot-sass {
  0%, 100% { transform: rotate(0deg) scale(1); }
  20% { transform: rotate(-8deg) scale(1.05); }
  40% { transform: rotate(6deg) scale(1); }
  60% { transform: rotate(-3deg); }
}
@keyframes mascot-squish {
  0% { transform: scaleY(1) scaleX(1); }
  20% { transform: scaleY(0.6) scaleX(1.3); }
  50% { transform: scaleY(1.3) scaleX(0.8); }
  100% { transform: scaleY(1) scaleX(1); }
}
@keyframes mascot-look {
  0%, 100% { transform: translateX(0) rotate(0deg); }
  25% { transform: translateX(-6px) rotate(-5deg); }
  75% { transform: translateX(6px) rotate(5deg); }
}
@keyframes mascot-dance {
  0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
  25% { transform: translateY(-8px) rotate(-15deg) scale(1.1); }
  50% { transform: translateY(0) rotate(0deg) scale(1); }
  75% { transform: translateY(-8px) rotate(15deg) scale(1.1); }
}
@keyframes mascot-facepalm {
  0% { transform: rotate(0deg); }
  30% { transform: rotate(-10deg) translateY(5px); }
  60% { transform: rotate(-15deg) translateY(8px) scale(0.9); }
  100% { transform: rotate(-10deg) translateY(3px) scale(0.95); }
}
@keyframes mascot-powerup {
  0%, 100% { transform: translateY(0) scale(1.05) rotate(0deg); }
  33% { transform: translateY(-6px) scale(1.1) rotate(-2deg); }
  66% { transform: translateY(-4px) scale(1.08) rotate(2deg); }
}
@keyframes mascot-frenzy {
  0% { transform: translateY(0) rotate(0deg) scale(1.05); }
  15% { transform: translateY(-8px) rotate(-8deg) scale(1.1); }
  30% { transform: translateY(-2px) rotate(5deg) scale(1.05); }
  45% { transform: translateY(-10px) rotate(-5deg) scale(1.1); }
  60% { transform: translateY(-2px) rotate(7deg) scale(1.05); }
  75% { transform: translateY(-8px) rotate(-7deg) scale(1.1); }
  100% { transform: translateY(0) rotate(0deg) scale(1.05); }
}
@keyframes money-rain {
  0% { transform: translateY(0) rotate(0deg) scale(1); opacity: 1; }
  30% { opacity: 1; }
  100% { transform: translateY(-350px) rotate(720deg) scale(0.5); opacity: 0; }
}
@keyframes frenzy-ring {
  0% { transform: translate(-50%, -50%) scale(0.3); opacity: 1; border-width: 4px; }
  100% { transform: translate(-50%, -50%) scale(4); opacity: 0; border-width: 1px; }
}
@keyframes power-ring {
  0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; border-width: 3px; }
  100% { transform: translate(-50%, -50%) scale(2.5); opacity: 0; border-width: 1px; }
}
@keyframes power-particles {
  0% { transform: translateY(0) scale(1); opacity: 1; }
  100% { transform: translateY(-40px) scale(0); opacity: 0; }
}
@keyframes box-idle {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-2px) rotate(1deg); }
}
@keyframes box-bump-right {
  0% { transform: translateX(-75px) translateY(0) rotate(0deg); }
  20% { transform: translateX(-50px) translateY(-20px) rotate(90deg); }
  40% { transform: translateX(-25px) translateY(-30px) rotate(200deg); }
  60% { transform: translateX(-10px) translateY(-15px) rotate(300deg); }
  80% { transform: translateX(-3px) translateY(-5px) rotate(345deg); }
  100% { transform: translateX(0) translateY(0) rotate(360deg); }
}
@keyframes box-bump-left {
  0% { transform: translateX(75px) translateY(0) rotate(0deg); }
  20% { transform: translateX(50px) translateY(-20px) rotate(-90deg); }
  40% { transform: translateX(25px) translateY(-30px) rotate(-200deg); }
  60% { transform: translateX(10px) translateY(-15px) rotate(-300deg); }
  80% { transform: translateX(3px) translateY(-5px) rotate(-345deg); }
  100% { transform: translateX(0) translateY(0) rotate(-360deg); }
}
@keyframes damage-float {
  0% { transform: translateY(0) scale(0.5); opacity: 1; }
  20% { transform: translateY(-20px) scale(1.2); opacity: 1; }
  100% { transform: translateY(-80px) scale(0.8); opacity: 0; }
}
@keyframes speech-pop {
  0% { transform: scale(0); opacity: 0; }
  60% { transform: scale(1.08); }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes think-dot {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-8px); opacity: 1; }
}
@keyframes zzz-float {
  0% { transform: translateY(0) translateX(0) scale(0.5) rotate(-10deg); opacity: 0; }
  15% { opacity: 1; }
  100% { transform: translateY(-80px) translateX(30px) scale(1.3) rotate(10deg); opacity: 0; }
}
`;
