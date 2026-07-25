import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Stable keys for fixed-length skeleton/placeholder lists. Returns the same
 * string array for a given length, so mapping over it gives React stable keys
 * without using the array index as the key (lint/suspicious/noArrayIndexKey).
 */
export function skeletonKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `skeleton-${i}`);
}
