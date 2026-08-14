// 빌드 1회 실행기.
//
// 게이트 스크립트가 각자 `npm run build` 를 부르는 바람에 전체 검증 한 번에
// tsc 가 스무 번 넘게 dist 에 쓴다. Windows 에서 직전 테스트 프로세스가 아직
// 파일을 붙잡고 있으면 그 쓰기가 간헐적으로 실패하고, 매번 다른 게이트가 깨졌다
// (실제로 gate12·gate18·gate20·gate30 이 번갈아 실패했고 단독 실행은 전부 통과했다).
//
// HUAI_PREBUILT=1 이면 이미 빌드된 것으로 보고 건너뛴다.
// verify-operation-ready 가 맨 앞에서 한 번 빌드하고 이 값을 세운다.

import { spawnSync } from "node:child_process";

if (process.env.HUAI_PREBUILT === "1") {
  process.exit(0);
}

const result = spawnSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  stdio: "inherit",
  shell: true
});

process.exit(result.status ?? 1);
