import { useEffect, useRef, useState } from 'react';

interface UseInViewportOptions {
  threshold?: number;
  rootMargin?: string;
  onInView?: () => void;
}

export function useInViewport<T extends HTMLElement>(options: UseInViewportOptions = {}) {
  const { threshold = 0.5, rootMargin = '0px', onInView } = options;
  const [isInView, setIsInView] = useState(false);
  const elementRef = useRef<T | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    // Debounce callback to avoid excessive updates
    const handleIntersection = (entries: IntersectionObserverEntry[]) => {
      const entry = entries[0];
      if (!entry) return;

      const inView = entry.isIntersecting;

      setIsInView(inView);

      if (inView && onInView) {
        // Clear any pending callback
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        // Debounce the callback by 100ms
        timeoutRef.current = setTimeout(() => {
          onInView();
        }, 100);
      }
    };

    observerRef.current = new IntersectionObserver(handleIntersection, {
      threshold,
      rootMargin,
    });

    observerRef.current.observe(element);

    return () => {
      if (observerRef.current && element) {
        observerRef.current.unobserve(element);
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [threshold, rootMargin, onInView]);

  return { ref: elementRef, isInView };
}
