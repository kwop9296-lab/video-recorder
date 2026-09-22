// 구글 드라이브 얇은 래퍼 (drive.file 스코프). 폴더 보장/업로드/목록/삭제 + md5 무결성.
// 완료 판정은 소비자(오케스트레이터)가 appProperties.contentId 로 대조한다.
//
// 모든 호출은 일시적 오류(5xx·429·ECONNRESET 등)에 대해 지수 백오프로 재시도한다.
// 구글은 가끔 JSON 대신 에러 HTML 페이지를 돌려주는데, 그것도 상태코드로 알아본다.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { createOAuthClient } from './googleAuth.js';
import { log } from '../core/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRIABLE_NET = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETRESET|ENETUNREACH|EAI_AGAIN|EPIPE|socket hang up|network socket disconnected/i;

// 재시도할 만한 오류면 사람이 읽을 사유, 아니면 null (export 는 테스트용)
export function transientReason(e) {
  const status = Number(e?.status ?? e?.response?.status ?? (typeof e?.code === 'number' ? e.code : NaN));
  if (RETRIABLE_STATUS.has(status)) return `HTTP ${status}`;
  // 드라이브는 속도 제한을 403으로도 준다 — 권한 오류(영구)와 구분해서 이때만 재시도.
  if (status === 403 && /rate ?limit|quota|backendError/i.test(e?.message ?? '')) return 'HTTP 403 (속도 제한)';
  const net = RETRIABLE_NET.exec(`${e?.code ?? ''} ${e?.message ?? ''}`);
  if (net) return net[0];
  // 에러 HTML 페이지 (<title>Error 502 (Server Error)!!1</title>)
  const html = /<title>\s*Error (\d{3})/i.exec(e?.message ?? '');
  if (html && RETRIABLE_STATUS.has(Number(html[1]))) return `HTTP ${html[1]}`;
  return null;
}

// 에러 메시지 한 줄로 줄이기 — 구글 에러 HTML을 통째로 토해내지 않도록
export function briefError(e) {
  let m = String(e?.message ?? e);
  if (/<html|<!DOCTYPE/i.test(m)) {
    const t = /<title>([^<]{0,120})<\/title>/i.exec(m);
    m = t ? t[1].trim() : `HTTP ${e?.status ?? e?.code ?? '오류'}`;
  }
  return m.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// 일시적 오류면 2→4→8→16초(±25% 지터)로 재시도. 그 외/횟수 초과는 짧은 메시지로 던진다.
export async function withRetry(label, fn, { tries = 5, base = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn(i);
    } catch (e) {
      const why = transientReason(e);
      if (!why || i >= tries) throw new Error(`${label} 실패 — ${why ?? briefError(e)}`, { cause: e });
      const wait = Math.round(base * 2 ** (i - 1) * (0.75 + Math.random() * 0.5));
      log(`  ↻ ${label} ${why} — ${(wait / 1000).toFixed(0)}초 후 재시도 (${i}/${tries - 1})`);
      await sleep(wait);
    }
  }
}

export class DriveClient {
  constructor() {
    this.drive = google.drive({ version: 'v3', auth: createOAuthClient() });
  }

  // 이름의 폴더를 찾거나(없으면) 생성. drive.file 스코프라 "앱이 만든" 폴더만 보임.
  // 조회→생성을 통째로 재시도한다 — 생성 응답만 유실됐어도 다시 조회하면 그 폴더가 잡힌다(중복 생성 방지).
  async ensureFolder(name, parentId) {
    const q = [
      "mimeType='application/vnd.google-apps.folder'",
      `name='${String(name).replace(/'/g, "\\'")}'`,
      'trashed=false',
      parentId ? `'${parentId}' in parents` : null,
    ].filter(Boolean).join(' and ');
    return withRetry(`드라이브 폴더 '${name}'`, async () => {
      const res = await this.drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', supportsAllDrives: true });
      if (res.data.files?.length) return res.data.files[0].id;
      const created = await this.drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
        fields: 'id', supportsAllDrives: true,
      });
      return created.data.id;
    });
  }

  // 특정 콘텐츠가 이미 이 폴더에 올라와 있는지 타겟 조회(전체 리스트 없이 가볍게).
  // 위/아래 동시 녹화 시 "다른 PC가 방금 올렸나?" 를 항목마다 재확인하는 용도.
  async findByContentId(folderId, contentId) {
    const q = [
      `'${folderId}' in parents`,
      'trashed=false',
      `appProperties has { key='contentId' and value='${String(contentId).replace(/'/g, "\\'")}' }`,
    ].join(' and ');
    const res = await withRetry('드라이브 조회', () => this.drive.files.list({
      q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive', supportsAllDrives: true,
    }));
    return res.data.files?.length ? res.data.files[0] : null;
  }

  // 한 콘텐츠에 딸린 파일 전부(캡처는 분할되면 여러 장). 완료 판정·정리에 쓴다.
  async listByContentId(folderId, contentId) {
    const q = [
      `'${folderId}' in parents`,
      'trashed=false',
      `appProperties has { key='contentId' and value='${String(contentId).replace(/'/g, "\\'")}' }`,
    ].join(' and ');
    const res = await withRetry('드라이브 조회', () => this.drive.files.list({
      q, fields: 'files(id,name,appProperties)', pageSize: 100, spaces: 'drive', supportsAllDrives: true,
    }));
    return res.data.files || [];
  }

  async listFiles(folderId) {
    const files = [];
    let pageToken;
    do {
      const res = await withRetry('드라이브 목록', () => this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,size,md5Checksum,appProperties)',
        pageSize: 1000, pageToken, spaces: 'drive', supportsAllDrives: true,
      }));
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
  }

  // 파일 업로드 → { id, md5Checksum, size }
  // props: 추가 appProperties (예: 분할 캡처의 마지막 장에 붙이는 complete 표식)
  // 스트림은 한 번 읽으면 끝이라 재시도마다 새로 연다.
  async uploadFile({ folderId, name, filePath, contentId, props }) {
    const appProperties = { ...(contentId ? { contentId: String(contentId) } : {}), ...props };
    const res = await withRetry(`드라이브 업로드 '${name}'`, async (attempt) => {
      // 직전 시도가 사실은 올라갔는데 응답만 유실됐을 수 있다 → 같은 이름의 잔재를 먼저 치운다(중복 방지).
      if (attempt > 1 && contentId) {
        for (const f of await this.listByContentId(folderId, contentId).catch(() => [])) {
          if (f.name === name) await this.deleteFile(f.id).catch(() => {});
        }
      }
      return this.drive.files.create({
        requestBody: {
          name, parents: [folderId],
          appProperties: Object.keys(appProperties).length ? appProperties : undefined,
        },
        media: { body: fs.createReadStream(filePath) },
        fields: 'id, md5Checksum, size',
        supportsAllDrives: true,
      });
    });
    return res.data;
  }

  async deleteFile(id) {
    await withRetry('드라이브 삭제', () => this.drive.files.delete({ fileId: id, supportsAllDrives: true }));
  }
}

export function md5OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}
