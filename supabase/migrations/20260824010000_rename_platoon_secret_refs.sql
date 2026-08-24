-- 이전 마이그레이션(20260824000000)이 role 컬럼만 platoon_leader -> leader 로
-- 바꿨는데, huai_telegram_bots 의 token_secret_ref/webhook_secret_ref 에도
-- "env:BOT_SERVICE_PLATOON_..." 문자열이 그대로 남아 있었다 — 실측: 서비스
-- 재기동 후 missing-env:BOT_SERVICE_PLATOON_WEBHOOK_SECRET 로 즉시 죽었다.
-- 코드는 이미 BOT_SERVICE_LEADER_* 만 읽으므로 이 값도 같이 바꿔야 한다.
update huai_telegram_bots
set token_secret_ref = replace(token_secret_ref, 'BOT_SERVICE_PLATOON_', 'BOT_SERVICE_LEADER_')
where token_secret_ref like '%BOT_SERVICE_PLATOON_%';

update huai_telegram_bots
set webhook_secret_ref = replace(webhook_secret_ref, 'BOT_SERVICE_PLATOON_', 'BOT_SERVICE_LEADER_')
where webhook_secret_ref like '%BOT_SERVICE_PLATOON_%';
