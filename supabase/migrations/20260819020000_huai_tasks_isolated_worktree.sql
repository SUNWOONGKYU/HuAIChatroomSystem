-- "버전 N개 만들어줘" 같은 병렬 변형 요청을 지원한다.
--
-- 왜 필요한가: 리더가 한 번의 판단으로 제안을 N개(변형마다 하나) 만들면, 각 제안은
-- 기존 1:1(제안 하나 = 작업 하나) 불변식을 그대로 지킨다 — 승인 증거 체인(AC-08)도
-- 안 건드린다. 유일하게 새로 필요한 것은 "이 작업은 공유 프로젝트 폴더가 아니라
-- 자기만의 격리된 git worktree 에서 돌아야 한다"는 표시뿐이다. 그래야 변형 3개가
-- 동시에 같은 파일을 안 밟는다.
alter table huai_tasks
  add column if not exists use_isolated_worktree boolean not null default false;
