-- 20260831000000 에서 huai_gateway_instances_allowed_adapters_nonempty_check 를
-- NOT VALID 로 추가했다 — 기존 행 중 allowed_adapters 가 빈 배열인 것이 있으면
-- VALID 로 바로 추가할 경우 마이그레이션 자체가 실패하기 때문이다.
--
-- 그 뒤 운영 DB 의 huai_gateway_instances 전체(5행)를 실제로 조회해 빈 배열이
-- 하나도 없음을 확인했다(위반 0건). 기존 행까지 포함해 완전히 검증된 상태로 승격한다.
alter table huai_gateway_instances
  validate constraint huai_gateway_instances_allowed_adapters_nonempty_check;
