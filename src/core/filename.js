// 콘텐츠 제목 → 파일명. 녹화(.mkv)와 캡처(.png)가 같은 규칙을 쓰도록 한곳에 둔다.
export function sanitize(name) {
  return String(name).replace(/[<>:"/\\|?*\n\r\t]+/g, '_').replace(/\.+$/, '').trim().slice(0, 90) || 'video';
}
