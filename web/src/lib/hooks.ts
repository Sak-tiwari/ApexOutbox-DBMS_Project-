import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Page } from "./types";

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Keyset-paginated list: "Load more" button and/or infinite scroll via the sentinel ref. */
export function useCursorList<T>(key: string, path: string, params: Record<string, string | number | boolean | undefined>, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: [key, params],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api<Page<T>>(path, { query: { ...params, limit: 25, cursor: pageParam }, signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev, // keep showing old rows while a new search loads: no flicker
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage(); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);
  return { ...q, items, sentinel };
}

export const useGet = <T,>(key: unknown[], path: string, enabled = true) => useQuery({ queryKey: key, queryFn: ({ signal }) => api<T>(path, { signal }), enabled });
