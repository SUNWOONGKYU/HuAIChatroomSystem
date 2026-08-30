// stale-proposal-cleanup.test.ts 전용 가짜 스크립트.
//
// 진짜 scripts/cancel-stale-proposals.mjs 를 돌리면 Supabase 접속이 필요해 단위
// 테스트에서 쓸 수 없다. createStaleProposalCleanupRunner 가 실제 스크립트를
// "--apply --reason ..." 인자로 자식 프로세스 실행하는지(로직을 복제하지 않고
// 그대로 재사용하는지)만 확인하면 되므로, 받은 인자를 그대로 찍어주는 것으로 충분하다.
console.log(process.argv.slice(2).join(" "));
