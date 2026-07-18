// 구글 OAuth 클라이언트 — 우리 .env 의 GOOGLE_OAUTH_* 값만 사용 (drive.file 스코프).
// 자격증명이 없으면 바로 예외 (다른 프로젝트 경로에 의존하지 않음 → 다른 PC에서도 동일).

import 'dotenv/config';
import { google } from 'googleapis';

export function createOAuthClient() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const token = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!id || !secret || !token) {
    throw new Error('구글 OAuth 자격증명 없음 — .env 에 GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN 을 넣으세요.');
  }
  const client = new google.auth.OAuth2(id, secret);
  client.setCredentials({ refresh_token: token });
  return client;
}
