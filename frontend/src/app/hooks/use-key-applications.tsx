import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type UserKeyRow } from "../api/gateway";
import { useAuth } from "./use-auth";

/**
 * API Key 申请的驳回结果提示。
 *
 * 和抢先体验计划（use-early-access.tsx）同样的问题：notifications 表没有
 * auth_id，无法定向推送。但这里的数据形状不同——一个用户可能同时有多条历史
 * 申请，不是单行状态，所以已读水位存的是 `{申请id: reviewed_at}` 的 map，
 * 而不是单个时间戳。
 */

const SEEN_PREFIX = "apiplatform_key_apps_seen:";
/** 轮询间隔。审批是人工动作，分钟级足够。 */
const POLL_MS = 60_000;

function readSeen(authId: string): Record<string, string> {
  if (!authId) return {};
  try {
    const raw = localStorage.getItem(SEEN_PREFIX + authId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export interface KeyApplicationsHook {
  rows: UserKeyRow[];
  loading: boolean;
  /** 有未查看的驳回结果 */
  unread: boolean;
  refresh: () => Promise<void>;
  /** 把当前全部驳回记录标记为已读 */
  markSeen: () => void;
}

export function useKeyApplications(): KeyApplicationsHook {
  const { token, authId } = useAuth();
  const [rows, setRows] = useState<UserKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [seen, setSeen] = useState<Record<string, string>>(() => readSeen(authId));
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => { setSeen(readSeen(authId)); }, [authId]);

  const refresh = useCallback(async () => {
    if (!tokenRef.current) { setRows([]); return; }
    setLoading(true);
    try {
      const res = await api.userKeys(tokenRef.current);
      setRows(res.data);
    } catch {
      /* 静默：这是背景轮询，失败不打扰用户；下一轮自然重试 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) { setRows([]); return; }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, refresh]);

  const rejected = useMemo(() => rows.filter((r) => r.status === "rejected"), [rows]);

  const markSeen = useCallback(() => {
    if (!authId || rejected.length === 0) return;
    const next = { ...seen };
    for (const r of rejected) {
      if (r.reviewed_at) next[r.id] = r.reviewed_at;
    }
    try {
      localStorage.setItem(SEEN_PREFIX + authId, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setSeen(next);
  }, [authId, rejected, seen]);

  const unread = useMemo(
    () => rejected.some((r) => r.reviewed_at && seen[r.id] !== r.reviewed_at),
    [rejected, seen],
  );

  return { rows, loading, unread, refresh, markSeen };
}
