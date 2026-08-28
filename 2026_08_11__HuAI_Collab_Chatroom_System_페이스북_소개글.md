# HuAI Collab Chatroom System 소개글 — Facebook 게시용

## 짧은 버전

AI와 함께 일하는 공간을 Telegram 프로젝트방 안에 만들었습니다.

HuAI Collab Chatroom System은 사람이 Telegram 방에서 평소처럼 요청하면, LeaderBot이 일을 제안으로 정리하고, CodexBot과 ClaudeBot이 (Claude Code·Codex·Antigravity 세 실행 엔진을 상황에 따라 돌아가며 써서) 실제 프로젝트 폴더에서 작업을 수행하며, AuditBot이 의미 있는 결과물을 독립 검증하는 협업 운영 시스템입니다.

별도 앱을 설치하지 않아도 됩니다. 사람은 Telegram에서 요청하고, 협업 운영센터에서 결정합니다. 중앙 오케스트레이터는 권한, 작업 상태, 실행 순서, 중복 처리, 검증 흐름을 관리하고, Supabase DB가 공식 작업 기록의 기준이 됩니다. 실제 코딩과 파일 작업은 작업 PC의 local-gateway를 통해 제한된 프로젝트 폴더에서 실행됩니다.

이제 작업 목록과 이력도 Telegram에서 바로 확인할 수 있습니다. `/tasks`, `/task <id>`, `/search <단어>`, `/trace <task_id>`로 작업 상태, 상세, 검색 결과, 이벤트·산출물 URI·검증 이력을 볼 수 있습니다. 내부 JSON, 훅 로그, 토큰, 비밀 query 값은 사람에게 노출하지 않습니다.

핵심은 단순한 채팅봇이 아니라, 요청 → 제안 → 방장 실행 승인 → 실제 작업 → 결과 보고 → 필요 시 검증 → 보완 또는 완료 승인까지 이어지는 운영형 Human-AI 협업 흐름입니다.

## 긴 버전

HuAI Collab Chatroom System은 “AI에게 일을 시키는 별도 화면”을 새로 만드는 대신, 사람들이 이미 쓰는 Telegram 프로젝트방을 실제 업무 지휘소로 사용하는 시스템입니다.

방 안에는 사람 참여자와 역할별 AI 봇이 함께 들어옵니다.

- LeaderBot: 사람의 요청을 작업 제안으로 정리하고 승인·라우팅 흐름을 관리합니다.
- CodexBot: Codex로 실제 코드·파일 작업을 수행하고 결과를 보고합니다.
- ClaudeBot: Claude Code가 필요한 작업을 맡아 수행합니다.
- AuditBot: 의미 있는 결과물을 독립적으로 검증하고, 사람이 직접 요청한 감사도 처리합니다.
- (실행 엔진 3종) Claude Code·Codex·Antigravity 중 하나가 사용 한도에 걸리면 다른 엔진이 바로 이어받습니다.

사람은 복잡한 대시보드에 들어갈 필요 없이 Telegram에서 말하면 됩니다.
질문은 LeaderBot이 바로 답하고, 실제 변경이나 실행이 필요한 말만 작업 제안으로 정리합니다.

```text
@leader_chatroom_bot 현재 프로젝트 진행 상황을 파악해서 보고해봐
@leader_chatroom_bot 클로드 팀원 불러서 이 작업 해
@leader_chatroom_bot 코덱스로 이 기능 구현해
@leader_chatroom_bot ClaudeBot과 CodexBot이 각각 의견 내고 AuditBot이 검증해서 결론 내줘
@leader_chatroom_bot 이번 주 작업 내역 정리해서 보고서 파일로 만들어줘
```

LeaderBot은 요청을 사람이 판단하기 쉬운 작업 제안으로 바꿉니다. ClaudeBot과 CodexBot을 함께 부르는 요청은 다중 AI 협의 작업으로 정리됩니다. 방장은 협업 운영센터에서 `승인`, `수정`, `반려`를 결정합니다. 승인된 작업은 중앙 오케스트레이터를 거쳐 Supabase DB에 기록되고, local-gateway가 연결된 작업 PC에서 Codex·Claude Code·Antigravity 중 하나를 실행합니다.

실행 결과는 사람이 알아야 할 내용만 Telegram에 표시합니다. 긴 내부 로그, JSON 이벤트, hook 출력, 토큰 사용량, 불필요한 경로 나열은 숨깁니다. 다만 필요한 경우에는 `/trace <task_id>`로 공식 기록을 조회할 수 있습니다. 이 명령은 이벤트 종류와 시간, 산출물 URI와 버전, 검증 판정 이력을 Telegram에 직접 보여주되, 원문 payload와 비밀값은 노출하지 않습니다.

AuditBot은 모든 작은 응답마다 자동으로 붙지 않습니다. 보안, DB 변경, 배포, 구현 완료, 문서 작성, 중요한 산출물처럼 검증할 가치가 있는 결과물이 생겼을 때만 검증 흐름으로 넘어갑니다. 사람이 원하면 `@audit_chatroom_bot`으로 직접 감사나 보안 검토를 요청할 수도 있습니다.

버튼 문구도 운영자가 바로 이해하도록 단순화했습니다.

- 작업 제안(협업 운영센터): `승인`, `수정`, `반려`
- 완료 결정(협업 운영센터): `승인`, `보완 요청`

이 시스템에서 Telegram은 대화 화면이고, 공식 작업 상태의 기준은 중앙 DB입니다. 그래서 중복 메시지, 중복 승인, 봇 간 무한 대화, 잘못된 프로젝트 폴더 실행을 막는 구조를 갖추고 있습니다.

확장 방식은 공통 봇 4개를 여러 프로젝트방에 초대해 재사용하는 방식입니다. 새 프로젝트가 생기면 새 Telegram 비공개 그룹을 만들고, LeaderBot·CodexBot·ClaudeBot·AuditBot을 초대한 뒤, 해당 그룹의 `telegram_chat_id`를 Supabase room과 로컬 프로젝트 폴더에 연결합니다. 같은 봇을 쓰더라도 각 room은 방장, 참여자, 작업 폴더, gateway 실행 범위가 분리됩니다.

제가 만든 것은 단순한 AI 챗봇이 아닙니다. 사람과 여러 AI 실행자가 하나의 프로젝트방 안에서 같이 일하고, 승인과 검증을 거쳐 실제 결과물을 만들어내는 협업 운영 시스템입니다.

온라인 채팅방 기반 에이전트 제작 지원과 자문 서비스로 확장할 수 있는 기반이기도 합니다. 고객과 Telegram 방에서 상시로 대화하며 필요한 에이전트와 자동화 작업을 만들고, AI 작업팀이 실행하고, 독립 검증자가 결과를 점검하는 구조입니다.

보여주기용 데모가 아니라 실제 업무에 투입되는 정식 운영 버전으로 운영하고 있습니다.

## 게시용 한 문장

사람, Codex, Claude Code, Antigravity, 독립 검증자가 Telegram 프로젝트방 하나에서 함께 일하고 기록까지 남는 AI 협업 사무실 구조를 만들었습니다.

## 해시태그

#HuAI #AI협업 #TelegramBot #Codex #ClaudeCode #AuditBot #업무자동화 #AI에이전트 #HumanAI
