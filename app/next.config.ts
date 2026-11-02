import type { NextConfig } from "next";
import { assertFixtureModeAllowed } from "./src/server/runtime-mode";

// 운영 빌드(next build)·운영 실행(next start)에서 로컬 고정 사용자 모드가 켜져 있으면 여기서 거부한다.
export default function config(phase: string): NextConfig {
  assertFixtureModeAllowed(phase, process.env);
  return {
    reactStrictMode: true,
    poweredByHeader: false,
    devIndicators: false,
    // next dev가 app/AGENTS.md를 자동 생성하지 않게 한다. 에이전트 지침은 저장소 루트 AGENTS.md가 정본이다.
    agentRules: false,
  };
}
