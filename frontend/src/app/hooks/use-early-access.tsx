import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type EarlyAccessState } from "../api/gateway";
import { useAuth } from "./use-auth";

/**
 * 抢先体验计划状态 + 未读提示。
 *
 * 平台的 notifications 表没有 auth_id，无法把审批结果定向投递给申请人；在不动
 * 表结构的前提下，用轮询 + 本地已读水位实现"结果触达"：拿到审批结果（reviewed_at
 * 有值）且该结果未被本人查看过时，右上角姓名旁挂红点，打开弹窗即消。
 *
 * 已读水位存 localStorage 且按 authId 分键——同一台电脑换人登录不会互相顶掉，
 * 也不会把别人的"已读"当成自己的。水位存的是 reviewed_at 而非布尔值：管理员
 * 二次处理（通过→撤销→再通过）会刷新 reviewed_at，于是自动变回未读。
 */

const SEEN_PREFIX = "apiplatform_ea_seen:";
/** 轮询间隔。审批是人工动作，分钟级足够；结果落定后仍继续轮询以便感知"撤销"。 */
const POLL_MS = 60_000;

function readSeen(authId: string): string {
  if (!authId) return "";
  try {
    return localStorage.getItem(SEEN_PREFIX + authId) || "";
  } catch {
    return "";
  }
}

export interface EarlyAccessHook {
  state: EarlyAccessState | null;
  loading: boolean;
  /** 有未查看的审批结果 */
  unread: boolean;
  refresh: () => Promise<void>;
  /** 标记当前审批结果为已读（打开弹窗时调用） */
  markSeen: () => void;
}

export function useEarlyAccess(): EarlyAccessHook {
  const { token, authId } = useAuth();
  const [state, setState] = useState<EarlyAccessState | null>(null);
  const [loading, setLoading] = useState(false);
  const [seen, setSeen] = useState(() => readSeen(authId));
  // 轮询回调里要读最新 token，又不希望 token 变化重建定时器
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => { setSeen(readSeen(authId)); }, [authId]);

  const refresh = useCallback(async () => {
    if (!tokenRef.current) { setState(null); return; }
    setLoading(true);
    try {
      setState(await api.earlyAccess(tokenRef.current));
    } catch {
      /* 静默：这是背景轮询，失败不打扰用户；下一轮自然重试 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) { setState(null); return; }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // 切回标签页时立即对齐一次，避免后台标签页被浏览器降频后状态陈旧
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, refresh]);

  const markSeen = useCallback(() => {
    const at = state?.reviewed_at;
    if (!at || !authId) return;
    try {
      localStorage.setItem(SEEN_PREFIX + authId, at);
    } catch {
      /* ignore */
    }
    setSeen(at);
  }, [state?.reviewed_at, authId]);

  const unread = useMemo(
    () => Boolean(state?.reviewed_at && state.reviewed_at !== seen),
    [state?.reviewed_at, seen],
  );

  return { state, loading, unread, refresh, markSeen };
}
