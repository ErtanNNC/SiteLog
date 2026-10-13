import { resetDemoStore } from '@/data/demo/store';
import { isDemo } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { storage } from '@/lib/utils';

/** Demo mode: the §18 user signed in on this device (`AuthProvider` reads it on boot). */
export const DEMO_SESSION_KEY = 'sitelog.demo.session';

/**
 * Ends the session without the auth provider: the demo session and data, or the Supabase session.
 * `AuthProvider.signOut` uses it, and so does the error boundary, which sits outside the provider.
 */
export async function clearSession(): Promise<void> {
  if (isDemo) {
    storage.remove(DEMO_SESSION_KEY);
    resetDemoStore();
    return;
  }
  await supabase?.auth.signOut();
}
