// 구글 드라이브 얇은 래퍼 (drive.file 스코프). 폴더 보장/업로드/목록/삭제 + md5 무결성.
// 완료 판정은 소비자(오케스트레이터)가 appProperties.contentId 로 대조한다.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { createOAuthClient } from './googleAuth.js';

export class DriveClient {
  constructor() {
    this.drive = google.drive({ version: 'v3', auth: createOAuthClient() });
  }

  // 이름의 폴더를 찾거나(없으면) 생성. drive.file 스코프라 "앱이 만든" 폴더만 보임.
  async ensureFolder(name, parentId) {
    const q = [
      "mimeType='application/vnd.google-apps.folder'",
      `name='${String(name).replace(/'/g, "\\'")}'`,
      'trashed=false',
      parentId ? `'${parentId}' in parents` : null,
    ].filter(Boolean).join(' and ');
    const res = await this.drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', supportsAllDrives: true });
    if (res.data.files?.length) return res.data.files[0].id;
    const created = await this.drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
      fields: 'id', supportsAllDrives: true,
    });
    return created.data.id;
  }

  // 특정 콘텐츠가 이미 이 폴더에 올라와 있는지 타겟 조회(전체 리스트 없이 가볍게).
  // 위/아래 동시 녹화 시 "다른 PC가 방금 올렸나?" 를 항목마다 재확인하는 용도.
  async findByContentId(folderId, contentId) {
    const q = [
      `'${folderId}' in parents`,
      'trashed=false',
      `appProperties has { key='contentId' and value='${String(contentId).replace(/'/g, "\\'")}' }`,
    ].join(' and ');
    const res = await this.drive.files.list({
      q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive', supportsAllDrives: true,
    });
    return res.data.files?.length ? res.data.files[0] : null;
  }

  async listFiles(folderId) {
    const files = [];
    let pageToken;
    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,size,md5Checksum,appProperties)',
        pageSize: 1000, pageToken, spaces: 'drive', supportsAllDrives: true,
      });
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
  }

  // 파일 업로드 → { id, md5Checksum, size }
  async uploadFile({ folderId, name, filePath, contentId }) {
    const res = await this.drive.files.create({
      requestBody: {
        name, parents: [folderId],
        appProperties: contentId ? { contentId: String(contentId) } : undefined,
      },
      media: { body: fs.createReadStream(filePath) },
      fields: 'id, md5Checksum, size',
      supportsAllDrives: true,
    });
    return res.data;
  }

  async deleteFile(id) {
    await this.drive.files.delete({ fileId: id, supportsAllDrives: true });
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
