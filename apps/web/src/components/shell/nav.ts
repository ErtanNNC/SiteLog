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
  Smartphone,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { canAccess, ROUTE_ROLES, type RouteKey } from '@/auth/guards';

export interface NavItem {
  key: RouteKey;
  to: string;
  /** The `nav.*` copy key of the label (`t()`, D9). */
  label: NavLabelKey;
  icon: LucideIcon;
  group: 'main' | 'setup';
  badge?: NavBadge;
  badgeTone?: 'level' | 'signal';
  end?: boolean;
  /**
   * Active on every path under this prefix, not only on `to`: Settings opens `/settings/reports`
   * but is the current item on every Settings tab. (`to` stays a tab: `/settings` is a redirect,
   * which would unmount the page and drop an unsaved draft without the guard asking.)
   */
  activePrefix?: string;
  /** Only in demo mode (the field simulator needs the in-memory demo data). */
  demoOnly?: boolean;
}

export type NavLabelKey = `nav.${Exclude<RouteKey, 'setup'>}`;
export type NavBadge = 'reportsToReview' | 'unknownSenders' | 'termsToReview';

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'overview',
    to: '/',
    label: 'nav.overview',
    icon: LayoutDashboard,
    group: 'main',
    end: true,
  },
  { key: 'sites', to: '/sites', label: 'nav.sites', icon: HardHat, group: 'main' },
  {
    key: 'reports',
    to: '/reports',
    label: 'nav.reports',
    icon: FileText,
    group: 'main',
    badge: 'reportsToReview',
    badgeTone: 'level',
  },
  { key: 'hours', to: '/hours', label: 'nav.hours', icon: Clock, group: 'main' },
  { key: 'weather', to: '/weather', label: 'nav.weather', icon: CloudRain, group: 'main' },
  {
    key: 'try',
    to: '/try',
    label: 'nav.try',
    icon: MessageSquareText,
    group: 'main',
    demoOnly: true,
  },
  {
    key: 'team',
    to: '/team',
    label: 'nav.team',
    icon: Users,
    group: 'setup',
    badge: 'unknownSenders',
    badgeTone: 'signal',
  },
  {
    key: 'glossary',
    to: '/glossary',
    label: 'nav.glossary',
    icon: BookOpen,
    group: 'setup',
    badge: 'termsToReview',
    badgeTone: 'signal',
  },
  {
    key: 'settings',
    to: '/settings/reports',
    activePrefix: '/settings/',
    label: 'nav.settings',
    icon: Settings,
    group: 'setup',
  },
  { key: 'billing', to: '/billing', label: 'nav.billing', icon: CreditCard, group: 'setup' },
  // §11.1: admins, of a demo org (`orgs.is_demo`) or on staging (`VITE_DEMO_PHONE_ALL_ORGS`).
  {
    key: 'devPhone',
    to: '/dev/phone',
    label: 'nav.devPhone',
    icon: Smartphone,
    group: 'setup',
  },
];

/**
 * Role-aware nav: hide Settings/Billing for non-admins; accounts users only see Crew hours. The
 * Demo phone shows only where it works (`demoPhone`: the panel's demo mode, a demo org, staging).
 */
export function navItemsFor(
  role: MemberRole | null,
  isDemo = false,
  opts: { demoPhone?: boolean } = {},
): NavItem[] {
  if (!role) return [];
  const demoPhone = opts.demoPhone ?? isDemo;
  return NAV_ITEMS.filter(
    (item) =>
      canAccess(role, ROUTE_ROLES[item.key]) &&
      (!item.demoOnly || isDemo) &&
      (item.key !== 'devPhone' || demoPhone),
  );
}
