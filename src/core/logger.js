// 아주 단순한 타임스탬프 로거.
const t = () => new Date().toTimeString().slice(0, 8);
export const log = (...a) => console.log(t(), ...a);
export const err = (...a) => console.error(t(), ...a);
