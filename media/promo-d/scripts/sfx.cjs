/* 부드러운 클릭음 트랙(assets/audio/clicks.m4a, 20초, 48kHz 스테레오)을 ffmpeg 수식으로 직접 합성한다.
   외부 음원·유료 생성 없음. 클릭 시각은 timeline.cjs의 press(누름) 프레임과 같다.
   사용: node scripts/sfx.cjs  (ffmpeg 필요) */
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");
const T = require(path.resolve(__dirname, "../timeline.cjs"));
const OUT = path.resolve(__dirname, "../assets/audio/clicks.m4a");

// 짧고 둥근 '톡': 낮은 사인 두 개 + 빠른 감쇠, 고역은 잘라 귀에 거슬리지 않게
const tick = "0.55*sin(2*PI*1150*t)*exp(-t*70)+0.30*sin(2*PI*2300*t)*exp(-t*120)+0.20*sin(2*PI*520*t)*exp(-t*45)";
const presses = T.clicks.map((c) => c.press);
const inputs = ["-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${T.duration}`];
presses.forEach(() => inputs.push("-f", "lavfi", "-i", `aevalsrc='${tick}':s=48000:d=0.12`));
const chains = presses.map((t, i) =>
  `[${i + 1}]lowpass=f=3800,afade=t=in:d=0.003,volume=0.28,aformat=channel_layouts=stereo,adelay=${Math.round(t * 1000)}:all=1[c${i}]`);
const mix = `[0]${presses.map((_, i) => `[c${i}]`).join("")}amix=inputs=${presses.length + 1}:normalize=0:duration=first,atrim=0:${T.duration}[out]`;
execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", chains.concat(mix).join(";"),
  "-map", "[out]", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", OUT], { stdio: "inherit" });
console.log("clicks.m4a @", presses.join(", "));
