// 완료 승인이 난 작업의 웹 산출물을 프로덕션으로 승격한다.
//
// artifact-publisher.ts 가 실행 직후 올리는 건 프리뷰뿐이다(방장 승인 전 프로덕션
// 노출 방지, Grok Bot 사례 반영·2026-08-23). 그 프리뷰가 실제로 프로덕션이 되는
// 시점은 huai_tasks.status 가 'completed' 로 바뀐 뒤뿐이다 — Telegram 버튼과 Mini App
// 버튼 둘 다 결국 이 컬럼을 그렇게 바꾸므로(applyOwnerCallback, packages/orchestrator),
// 승인 채널이 무엇이었는지 여기서 신경 쓸 필요가 없다. huai_tasks.status 하나만 본다.
//
// 왜 오케스트레이터 안에 안 넣는가: applyOwnerCallback 은 순수 함수(네트워크 호출 없이
// outbox 항목만 만든다)다. vercel promote 는 실제 네트워크 호출이라 거기 넣으면 그
// 함수의 순수성이 깨지고, 미니앱 승인 경로(miniapp-decision-poller.ts)와 텔레그램
// 실시간 경로 양쪽에 각각 신경 써서 다시 걸어야 한다. 대신 이 파일은 DB 상태
// (huai_tasks.status='completed' + huai_artifacts.is_final=false) 만 보고 도는
// 독립 폴러다 — 두 승인 경로가 이미 수렴하는 지점을 그대로 재사용한다.
//
// 2026-08-23 1회성 백필: 이 기능이 생기기 전에 만들어진 산출물은 이미 --prod 로
// 바로 배포돼 있었다(is_final 컬럼 자체가 그때까지 아무도 안 쓰던 장식용 값이었다).
// 그 행들은 전부 is_final=true 로 일괄 마감했다 — 이 폴러는 그 이후에 새로 생기는
// (완료됐는데 아직 안 올린) 행만 본다.

export type PromotableArtifact = {
  artifactId: string;
  taskId: string;
  publicUrl: string;
};

export type ArtifactPromotionStore = {
  // is_final=false 인데 taskId 가 completed 인 웹 산출물(.vercel.app) 을 가져온다.
  fetchPromotable(limit: number): Promise<PromotableArtifact[]>;
  markPromoted(artifactIds: readonly string[]): Promise<void>;
};

export type ArtifactPromotionResult = {
  checked: number;
  promoted: number;
  failed: number;
};

// 여러 파일이 한 배포(baseUrl)를 공유하므로, 같은 baseUrl 을 여러 번 promote 하지
// 않는다 — Vercel 쪽엔 멱등이겠지만 호출을 아낄 이유가 없는 것도 아니다.
export function groupByBaseUrl(artifacts: readonly PromotableArtifact[]): Map<string, PromotableArtifact[]> {
  const groups = new Map<string, PromotableArtifact[]>();
  for (const artifact of artifacts) {
    const base = baseUrlOf(artifact.publicUrl);
    if (!base) continue; // vercel.app 이 아닌 public_url(방어적) — 승격 대상 아님.
    const list = groups.get(base) ?? [];
    list.push(artifact);
    groups.set(base, list);
  }
  return groups;
}

export function baseUrlOf(publicUrl: string): string | undefined {
  try {
    const url = new URL(publicUrl);
    if (!url.hostname.endsWith(".vercel.app")) return undefined;
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return undefined;
  }
}

export async function promoteApprovedArtifacts(deps: {
  store: ArtifactPromotionStore;
  promote: (deploymentUrl: string) => Promise<{ ok: boolean; failureReason?: string }>;
  limit?: number;
  onFailure?: (baseUrl: string, reason: string | undefined) => void;
}): Promise<ArtifactPromotionResult> {
  const artifacts = await deps.store.fetchPromotable(deps.limit ?? 20);
  if (artifacts.length === 0) return { checked: 0, promoted: 0, failed: 0 };

  const groups = groupByBaseUrl(artifacts);
  const promotedIds: string[] = [];
  let failed = 0;

  for (const [baseUrl, group] of groups) {
    const result = await deps.promote(baseUrl);
    if (result.ok) {
      promotedIds.push(...group.map((artifact) => artifact.artifactId));
    } else {
      failed += group.length;
      deps.onFailure?.(baseUrl, result.failureReason);
    }
  }

  if (promotedIds.length > 0) await deps.store.markPromoted(promotedIds);

  return { checked: artifacts.length, promoted: promotedIds.length, failed };
}

// 이 파일 전용 최소 REST 클라이언트 — miniapp-decision-poller.ts 와 같은 이유로
// 여기서도 새 얇은 fetch 래퍼를 둔다(배관 코드 중복은 이 저장소가 이미 택한 패턴).
export function buildArtifactPromotionStore(config: {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): ArtifactPromotionStore {
  const baseUrl = config.url.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers = {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    "content-type": "application/json"
  };

  return {
    async fetchPromotable(limit) {
      const response = await fetchImpl(
        `${baseUrl}/rest/v1/huai_artifacts?select=artifact_id,task_id,public_url,huai_tasks(status)` +
          `&is_final=eq.false&public_url=ilike.*.vercel.app*&order=created_at.asc&limit=${limit}`,
        { headers, signal: AbortSignal.timeout(20_000) }
      );
      if (!response.ok) throw new Error(`artifact-promotion-fetch-failed:${response.status}`);
      const rows = (await response.json()) as Array<{
        artifact_id: string;
        task_id: string;
        public_url: string | null;
        huai_tasks: { status: string } | null;
      }>;
      return rows
        .filter((row) => row.huai_tasks?.status === "completed" && row.public_url)
        .map((row) => ({ artifactId: row.artifact_id, taskId: row.task_id, publicUrl: row.public_url! }));
    },
    async markPromoted(artifactIds) {
      if (artifactIds.length === 0) return;
      const quoted = artifactIds.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",");
      const response = await fetchImpl(
        `${baseUrl}/rest/v1/huai_artifacts?artifact_id=in.(${encodeURIComponent(quoted)})`,
        {
          method: "PATCH",
          headers: { ...headers, prefer: "return=minimal" },
          body: JSON.stringify({ is_final: true }),
          signal: AbortSignal.timeout(20_000)
        }
      );
      if (!response.ok && response.status !== 409) {
        throw new Error(`artifact-promotion-mark-failed:${response.status}`);
      }
    }
  };
}
