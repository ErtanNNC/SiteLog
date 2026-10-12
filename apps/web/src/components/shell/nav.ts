import type { MemberRole } from '@sitelog/shared/enums.ts';
import {
  BookOpen,
  Clock,
  CloudRain,
  CreditCard,
  FileText,
  HardHat,
  LayoutDashboard,
  MessageSquareText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ROUTE_ROLES } from '@/auth/guards';
import { copy } from '@/copy/en';

export interface NavItem {
  key: keyof typeof ROUTE_ROLES;
  to: string;
  label: string;
  icon: LucideIcon;
  group: 'main' | 'setup';
  badge?: 'reportsToReview' | 'unknownSenders' | 'termsToReview';
  badgeTone?: 'level' | 'signal';
  end?: boolean;
  /** Only in demo mode (the field simulator needs the in-memory demo data). */
  demoOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'overview',
    to: '/',
    label: copy.nav.overview,
    icon: LayoutDashboard,
    group: 'main',
    end: true,
  },
  { key: 'sites', to: '/sites', label: copy.nav.sites, icon: HardHat, group: 'main' },
  {
    key: 'reports',
    to: '/reports',
    label: copy.nav.reports,
    icon: FileText,
    group: 'main',
    badge: 'reportsToReview',
    badgeTone: 'level',
  },
  { key: 'hours', to: '/hours', label: copy.nav.hours, icon: Clock, group: 'main' },
  { key: 'weather', to: '/weather', label: copy.nav.weather, icon: CloudRain, group: 'main' },
  {
    key: 'try',
    to: '/try',
    label: copy.nav.try,
    icon: MessageSquareText,
    group: 'main',
    demoOnly: true,
  },
  {
    key: 'team',
    to: '/team',
    label: copy.nav.team,
    icon: Users,
    group: 'setup',
    badge: 'unknownSenders',
    badgeTone: 'signal',
  },
  {
    key: 'glossary',
    to: '/glossary',
    label: copy.nav.glossary,
    icon: BookOpen,
    group: 'setup',
    badge: 'termsToReview',
    badgeTone: 'signal',
  },
  {
    key: 'settings',
    to: '/settings/reports',
    label: copy.nav.settings,
    icon: Settings,
    group: 'setup',
  },
  { key: 'billing', to: '/billing', label: copy.nav.billing, icon: CreditCard, group: 'setup' },
];

/** Role-aware nav: hide Settings/Billing for non-admins; accounts users only see Crew hours. */
export function navItemsFor(role: MemberRole | null, isDemo = false): NavItem[] {
  if (!role) return [];
  return NAV_ITEMS.filter(
    (item) => ROUTE_ROLES[item.key]?.includes(role) && (!item.demoOnly || isDemo),
  );
}
