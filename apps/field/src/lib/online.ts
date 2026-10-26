import { useSyncExternalStore } from 'react';

function subscribe(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

function read(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Whether the browser thinks it has a connection (`navigator.onLine`; false is reliable, true is a guess). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
