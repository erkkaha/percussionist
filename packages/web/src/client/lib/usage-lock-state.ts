type LockListener = (locked: boolean) => void;

let _locked = false;
const _listeners = new Set<LockListener>();

export function isGloballyLocked(): boolean {
  return _locked;
}

export function setGloballyLocked(locked: boolean): void {
  if (_locked === locked) return;
  _locked = locked;
  for (const fn of _listeners) fn(locked);
}

export function onGlobalLockChange(fn: LockListener): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}
