import { createContext } from 'react';
import type { UploadQueue } from './queue';

/** The app's one upload queue (`QueueProvider`, `useQueue`). */
export const QueueContext = createContext<UploadQueue | null>(null);
