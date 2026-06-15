import type { Category } from './usage-settings';

export const CATEGORY_COLORS: Record<Category, string> = {
  reviewing: 'bg-blue-500',
  planning: 'bg-emerald-500',
  other: 'bg-gray-500',
};

export function categorizeUsageRoute(pathname: string): Category {
  if (/^\/projects\/[^/]+\/board/.test(pathname)) return 'reviewing';
  if (/^\/sessions\/[^/]+$/.test(pathname)) return 'reviewing';
  if (/^\/projects\/[^/]+\/plans\//.test(pathname)) return 'planning';
  return 'other';
}
