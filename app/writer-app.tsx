"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type User } from "@supabase/supabase-js";

type Work = { id: string; userId: string; title: string; createdAt: string; updatedAt: string; revision: number };
type Chapter = { id: string; workId: string; userId: string; title: string; order: number; createdAt: string; updatedAt: string; revision: number };
type SyncStatus = "saved" | "saving" | "offline" | "error" | "conflict";
type Scene = { id: string; workId: string; chapterId: string; userId: string; title: string; content: string; order: number; createdAt: string; updatedAt: string; revision: number; syncStatus: SyncStatus; lastSyncedRevision?: number; deviceId?: string };
type Tombstone = { id: string; itemId: string; itemType: "work" | "chapter" | "scene"; userId: string; deletedAt: string; deviceId?: string };
type SceneVersion = { id: number; content: string; revision: number; savedAt: string };
type Settings = { theme: "system" | "light" | "dark"; fontSize: number; lineHeight: number; width: number; lockMinutes: string; reopen: boolean; showStatus: boolean };
type Snapshot = { version: 1; exportedAt: string; works: Work[]; chapters: Chapter[]; scenes: Scene[]; settings: Settings };

const DB_NAME = "shizuku-writer";
const CONTENT_STORE_NAMES = ["works", "chapters", "scenes"] as const;
const STORE_NAMES = [...CONTENT_STORE_NAMES, "tombstones"] as const;
const DEFAULT_SETTINGS: Settings = { theme: "system", fontSize: 18, lineHeight: 1.9, width: 760, lockMinutes: "5", reopen: true, showStatus: true };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const count = (text: string) => Array.from(text).filter(character => !/\s/u.test(character)).length;
const normalizePin = (value: string) => value
  .replace(/[０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
  .replace(/\D/g, "")
  .slice(0, 6);
const fmt = (iso: string) => new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      STORE_NAMES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function getAll<T>(store: typeof STORE_NAMES[number]): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function put<T>(store: typeof STORE_NAMES[number], value: T) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const r = db.transaction(store, "readwrite").objectStore(store).put(value);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
async function remove(store: typeof STORE_NAMES[number], id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const r = db.transaction(store, "readwrite").objectStore(store).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
async function clearStore(store: typeof STORE_NAMES[number]) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const r = db.transaction(store, "readwrite").objectStore(store).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function pinDigest(pin: string, salt: string) {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function Editor({ scene, workCount, onCommit, onSync, onBack, onFocus, onHistory }: { scene: Scene; workCount: number; onCommit: (content: string, status: SyncStatus) => Promise<void>; onSync: () => Promise<void>; onBack: () => void; onFocus: (value: boolean) => void; onHistory: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useRef(scene.content);
  const dirty = useRef(false);
  const onCommitRef = useRef(onCommit);
  const composing = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<SyncStatus>(scene.syncStatus);
  const [chars, setChars] = useState(count(scene.content));

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const schedule = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setStatus("saving");
    saveTimer.current = setTimeout(() => {
      setStatus("offline");
      dirty.current = false;
      onCommitRef.current(draft.current, "offline");
      const el = ref.current;
      if (el) localStorage.setItem(`cursor:${scene.id}`, JSON.stringify({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }));
    }, 400);
  }, [scene.id]);

  useEffect(() => {
    draft.current = scene.content;
    dirty.current = false;
    const el = ref.current;
    if (el) el.value = scene.content;
    const saved = localStorage.getItem(`cursor:${scene.id}`);
    if (saved && el) {
      try {
        const p = JSON.parse(saved);
        requestAnimationFrame(() => { el.setSelectionRange(p.start, p.end); el.scrollTop = p.scroll; });
      } catch {}
    }
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirty.current) onCommitRef.current(draft.current, "offline");
    };
  }, [scene.id]); // Deliberately never resets textarea while typing.

  useEffect(() => {
    if (dirty.current || composing.current || draft.current === scene.content) return;
    draft.current = scene.content;
    setChars(count(scene.content));
    setStatus(scene.syncStatus);
    const el = ref.current;
    if (el) el.value = scene.content;
  }, [scene.content, scene.revision, scene.syncStatus]);

  return (
    <main className="editorShell">
      <header className="editorBar">
        <button className="iconButton" onClick={onBack} aria-label="一覧へ戻る">←</button>
        <div className="sceneHeading"><span>{scene.title}</span><small>{status === "saving" ? "端末に保存中…" : status === "saved" ? "同期済み" : status === "offline" ? "端末に保存済み" : status === "conflict" ? "未同期の編集あり" : "同期エラー"}</small></div>
        <div className="editorActions"><button className="syncButton" onClick={async () => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          dirty.current = false;
          setStatus("offline");
          await onCommitRef.current(draft.current, "offline");
          await onSync();
        }}>保存・同期する</button><button className="focusButton" onClick={onHistory}>履歴</button><button className="focusButton" onClick={() => onFocus(true)}>集中</button></div>
      </header>
      <textarea
        ref={ref}
        className="manuscript"
        defaultValue={scene.content}
        aria-label="本文"
        spellCheck={false}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionUpdate={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; dirty.current = true; draft.current = e.currentTarget.value; setChars(count(draft.current)); schedule(); }}
        onInput={(e) => {
          dirty.current = true;
          draft.current = e.currentTarget.value;
          if (!composing.current && !(e.nativeEvent as InputEvent).isComposing) {
            setChars(count(draft.current));
            schedule();
          }
        }}
      />
      <footer className="editorFoot"><span>{chars.toLocaleString()}字</span><span>作品 {Math.max(0, workCount - count(scene.content) + chars).toLocaleString()}字</span></footer>
    </main>
  );
}

export function WriterApp({ accountEmail = "この端末", signOutPath }: { accountEmail?: string; signOutPath?: string }) {
  const [works, setWorks] = useState<Work[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [workId, setWorkId] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<"none" | "settings" | "backup" | "account">("none");
  const [focus, setFocus] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pinMode, setPinMode] = useState<"unlock" | "setup" | "none">("none");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [cloudMessage, setCloudMessage] = useState("");
  const [historyVersions, setHistoryVersions] = useState<SceneVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("writerSettings") || "{}") }; } catch { return DEFAULT_SETTINGS; }
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const syncRunning = useRef(false);
  const supabase = useMemo(() => {
    const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
    const nextEnv = typeof process !== "undefined" ? process.env : {};
    const url = viteEnv?.VITE_SUPABASE_URL || nextEnv.NEXT_PUBLIC_SUPABASE_URL;
    const key = viteEnv?.VITE_SUPABASE_ANON_KEY || nextEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return url && key ? createClient(url, key) : null;
  }, []);

  useEffect(() => {
    (async () => {
      let [w, c, s] = await Promise.all([getAll<Work>("works"), getAll<Chapter>("chapters"), getAll<Scene>("scenes")]);
      if (!w.length && !localStorage.getItem("writerInitialized")) {
        const t = now(), wid = uid(), cid = uid(), sid = uid();
        w = [{ id: wid, userId: "local", title: "夜の森で、あなたを待つ", createdAt: t, updatedAt: t, revision: 1 }];
        c = [{ id: cid, workId: wid, userId: "local", title: "第1章　はじまり", order: 0, createdAt: t, updatedAt: t, revision: 1 }];
        s = [{ id: sid, workId: wid, chapterId: cid, userId: "local", title: "シーン1", content: "雨の匂いが、まだ窓辺に残っていた。\n\n", order: 0, createdAt: t, updatedAt: t, revision: 1, syncStatus: "saved" }];
        await Promise.all([put("works", w[0]), put("chapters", c[0]), put("scenes", s[0])]);
      }
      localStorage.setItem("writerInitialized", "1");
      setWorks(w); setChapters(c); setScenes(s);
      const lastWork = localStorage.getItem("lastWorkId");
      const lastScene = localStorage.getItem("lastSceneId");
      if (settings.reopen && w.some(x => x.id === lastWork)) setWorkId(lastWork);
      if (settings.reopen && s.some(x => x.id === lastScene)) setSceneId(lastScene);
      const savedPinHash = localStorage.getItem("pinHash");
      const savedPinSalt = localStorage.getItem("pinSalt");
      const hasCompletePin = Boolean(savedPinHash && savedPinSalt);
      if (!hasCompletePin) {
        localStorage.removeItem("pinHash");
        localStorage.removeItem("pinSalt");
      }
      setLocked(true);
      setPinMode(hasCompletePin ? "unlock" : "setup");
      setReady(true);
    })().catch(() => setReady(true));
    navigator.serviceWorker?.register("./sw.js");
  }, []);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    localStorage.setItem("writerSettings", JSON.stringify(settings));
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--editor-size", `${settings.fontSize}px`);
    document.documentElement.style.setProperty("--editor-leading", `${settings.lineHeight}`);
    document.documentElement.style.setProperty("--editor-width", `${settings.width}px`);
  }, [settings]);
  useEffect(() => {
    if (locked || settings.lockMinutes === "close") return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { setSceneId(null); setWorkId(null); setLocked(true); setPinMode("unlock"); }, Number(settings.lockMinutes) * 60_000); };
    ["pointerdown", "keydown", "touchstart"].forEach(e => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { clearTimeout(timer); ["pointerdown", "keydown", "touchstart"].forEach(e => window.removeEventListener(e, arm)); };
  }, [locked, settings.lockMinutes]);
  useEffect(() => {
    const lockWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      const hasCompletePin = Boolean(localStorage.getItem("pinHash") && localStorage.getItem("pinSalt"));
      setSceneId(null);
      setWorkId(null);
      setPin("");
      setPinError("");
      setPinMode(hasCompletePin ? "unlock" : "setup");
      setLocked(true);
    };
    const lockOnPageHide = () => lockWhenHidden();
    document.addEventListener("visibilitychange", lockWhenHidden);
    window.addEventListener("pagehide", lockOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", lockWhenHidden);
      window.removeEventListener("pagehide", lockOnPageHide);
    };
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setFocus(false); };
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, []);

  const currentWork = works.find(w => w.id === workId);
  const currentScene = scenes.find(s => s.id === sceneId);
  const workScenes = useMemo(() => scenes.filter(s => s.workId === workId), [scenes, workId]);
  const workCount = useMemo(() => workScenes.reduce((n, s) => n + count(s.content), 0), [workScenes]);
  const sortedWorks = [...works].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const createWork = async () => {
    const t = now(), wid = uid(), cid = uid(), sid = uid();
    const w: Work = { id: wid, userId: "local", title: "無題の作品", createdAt: t, updatedAt: t, revision: 1 };
    const c: Chapter = { id: cid, workId: wid, userId: "local", title: "第1章", order: 0, createdAt: t, updatedAt: t, revision: 1 };
    const s: Scene = { id: sid, workId: wid, chapterId: cid, userId: "local", title: "シーン1", content: "", order: 0, createdAt: t, updatedAt: t, revision: 1, syncStatus: "saved" };
    await Promise.all([put("works", w), put("chapters", c), put("scenes", s)]);
    setWorks(v => [w, ...v]); setChapters(v => [...v, c]); setScenes(v => [...v, s]); setWorkId(wid); setSceneId(sid);
  };
  const createChapter = async () => {
    if (!workId) return;
    const t = now(); const c: Chapter = { id: uid(), workId, userId: "local", title: `第${chapters.filter(x => x.workId === workId).length + 1}章`, order: chapters.filter(x => x.workId === workId).length, createdAt: t, updatedAt: t, revision: 1 };
    await put("chapters", c); setChapters(v => [...v, c]);
  };
  const createScene = async (chapterId: string) => {
    if (!workId) return;
    const t = now(); const same = scenes.filter(x => x.chapterId === chapterId);
    const s: Scene = { id: uid(), workId, chapterId, userId: "local", title: `シーン${same.length + 1}`, content: "", order: same.length, createdAt: t, updatedAt: t, revision: 1, syncStatus: "saved" };
    await put("scenes", s); setScenes(v => [...v, s]); setSceneId(s.id); localStorage.setItem("lastSceneId", s.id);
  };
  const saveSceneToCloud = useCallback(async (scene: Scene, expectedRevision: number) => {
    if (!supabase || !user || !navigator.onLine) return { status: "offline" as const };
    const deviceId = localStorage.getItem("deviceId") || uid();
    localStorage.setItem("deviceId", deviceId);
    const { data, error } = await supabase.rpc("save_scene_if_current", {
      p_scene_id: scene.id,
      p_work_id: scene.workId,
      p_chapter_id: scene.chapterId,
      p_title: scene.title,
      p_content: scene.content,
      p_order: scene.order,
      p_expected_revision: expectedRevision,
      p_created_at: scene.createdAt,
      p_device_id: deviceId,
    });
    if (error) return { status: "error" as const, error };
    const result = data?.[0];
    if (result?.status === "saved") {
      return {
        status: "saved" as const,
        revision: Number(result.server_revision),
        updatedAt: result.server_updated_at as string,
        deviceId,
      };
    }
    return { status: "conflict" as const, revision: Number(result?.server_revision || 0) };
  }, [supabase, user]);

  const commit = useCallback(async (content: string, syncStatus: SyncStatus) => {
    if (!sceneId) return;
    const old = scenes.find(s => s.id === sceneId);
    if (old) {
      if (old.content === content) {
        if (old.syncStatus !== syncStatus) {
          const unchanged = { ...old, syncStatus };
          setScenes(v => v.map(s => s.id === sceneId ? unchanged : s));
          await put("scenes", unchanged);
        }
        return;
      }
      const updatedAt = now();
      const next = { ...old, content, updatedAt, revision: old.revision + 1, syncStatus };
      setScenes(prev => prev.map(s => s.id === sceneId ? next : s));
      await put("scenes", next);
    }
  }, [sceneId, scenes]);
  const openHistory = async () => {
    if (!currentScene || !supabase || !user) {
      alert("履歴はクラウド同期への接続後に利用できます。");
      return;
    }
    const { data, error } = await supabase
      .from("scene_versions")
      .select("id,content,revision,saved_at")
      .eq("scene_id", currentScene.id)
      .eq("user_id", user.id)
      .order("saved_at", { ascending:false })
      .limit(100);
    if (error) {
      alert("履歴を読み込めませんでした。現在の本文は変更されていません。");
      return;
    }
    setHistoryVersions((data || []).map(x => ({ id:x.id,content:x.content,revision:x.revision,savedAt:x.saved_at })));
    setHistoryOpen(true);
  };
  const restoreVersion = async (version: SceneVersion) => {
    if (!confirm(`${fmt(version.savedAt)}の本文を復元しますか？ 現在の本文も履歴に残ります。`)) return;
    await commit(version.content, "offline");
    setHistoryOpen(false);
  };
  const rename = async (kind: "work" | "chapter" | "scene", id: string, old: string) => {
    const title = prompt("新しいタイトル", old)?.trim(); if (!title) return;
    if (kind === "work") { const item = works.find(x => x.id === id)!; const next = { ...item, title, updatedAt: now(), revision: item.revision + 1 }; setWorks(v => v.map(x => x.id === id ? next : x)); await put("works", next); }
    if (kind === "chapter") { const item = chapters.find(x => x.id === id)!; const next = { ...item, title, updatedAt: now(), revision: item.revision + 1 }; setChapters(v => v.map(x => x.id === id ? next : x)); await put("chapters", next); }
    if (kind === "scene") { const item = scenes.find(x => x.id === id)!; const next = { ...item, title, updatedAt: now(), revision: item.revision + 1 }; setScenes(v => v.map(x => x.id === id ? next : x)); await put("scenes", next); }
  };
  const recordDeletion = async (itemType: Tombstone["itemType"], itemId: string) => {
    const deviceId = localStorage.getItem("deviceId") || uid();
    localStorage.setItem("deviceId", deviceId);
    const tombstone: Tombstone = {
      id: `${itemType}:${itemId}`,
      itemId,
      itemType,
      userId: user?.id || "local",
      deletedAt: now(),
      deviceId,
    };
    await put("tombstones", tombstone);
  };
  const deleteItem = async (kind: "work" | "chapter" | "scene", id: string) => {
    if (!confirm("削除しますか？ この操作は元に戻せません。")) return;
    await recordDeletion(kind, id);
    if (kind === "scene") { await remove("scenes", id); setScenes(v => v.filter(x => x.id !== id)); setSceneId(null); }
    if (kind === "chapter") {
      const ids = scenes.filter(x => x.chapterId === id).map(x => x.id); await Promise.all(ids.map(x => remove("scenes", x))); await remove("chapters", id);
      setScenes(v => v.filter(x => x.chapterId !== id)); setChapters(v => v.filter(x => x.id !== id));
    }
    if (kind === "work") {
      await Promise.all(scenes.filter(x => x.workId === id).map(x => remove("scenes", x.id))); await Promise.all(chapters.filter(x => x.workId === id).map(x => remove("chapters", x.id))); await remove("works", id);
      setWorks(v => v.filter(x => x.id !== id)); setChapters(v => v.filter(x => x.workId !== id)); setScenes(v => v.filter(x => x.workId !== id)); setWorkId(null);
    }
  };
  const moveScene = async (scene: Scene, dir: -1 | 1) => {
    const same = scenes.filter(x => x.chapterId === scene.chapterId).sort((a,b) => a.order-b.order); const i = same.findIndex(x => x.id === scene.id); const other = same[i + dir]; if (!other) return;
    const a = { ...scene, order: other.order }, b = { ...other, order: scene.order }; await Promise.all([put("scenes", a), put("scenes", b)]); setScenes(v => v.map(x => x.id === a.id ? a : x.id === b.id ? b : x));
  };
  const chooseScene = (s: Scene) => { setSceneId(s.id); localStorage.setItem("lastSceneId", s.id); };
  const chooseWork = (id: string) => { setWorkId(id); localStorage.setItem("lastWorkId", id); };
  const backup = () => download(`shizuku-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ version: 1, exportedAt: now(), works, chapters, scenes, settings }, null, 2), "application/json;charset=utf-8");
  const exportTxt = () => {
    if (!currentWork) return; let text = `${currentWork.title}\n\n`;
    chapters.filter(c => c.workId === currentWork.id).sort((a,b)=>a.order-b.order).forEach(c => { text += `■ ${c.title}\n\n`; scenes.filter(s => s.chapterId === c.id).sort((a,b)=>a.order-b.order).forEach(s => { text += `【${s.title}】\n${s.content}\n\n`; }); });
    download(`${currentWork.title}.txt`, text, "text/plain;charset=utf-8");
  };
  const restore = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as Snapshot;
      if (!Array.isArray(data.works) || !Array.isArray(data.chapters) || !Array.isArray(data.scenes)) throw new Error();
      backup();
      const replace = confirm("「OK」で全置換、「キャンセル」で追加インポートします。");
      if (replace) await Promise.all(CONTENT_STORE_NAMES.map(clearStore));
      const existing = new Set([...works, ...chapters, ...scenes].map(x => x.id));
      const map = new Map<string,string>();
      const remap = (id: string) => { if (!existing.has(id)) return id; if (!map.has(id)) map.set(id, uid()); return map.get(id)!; };
      const ws = data.works.map(x => ({ ...x, id: remap(x.id) }));
      const cs = data.chapters.map(x => ({ ...x, id: remap(x.id), workId: remap(x.workId) }));
      const ss = data.scenes.map(x => ({ ...x, id: remap(x.id), workId: remap(x.workId), chapterId: remap(x.chapterId) }));
      await Promise.all([...ws.map(x=>put("works",x)), ...cs.map(x=>put("chapters",x)), ...ss.map(x=>put("scenes",x))]);
      setWorks(replace ? ws : [...works, ...ws]); setChapters(replace ? cs : [...chapters, ...cs]); setScenes(replace ? ss : [...scenes, ...ss]); alert("復元しました。");
    } catch { alert("復元できませんでした。既存の原稿は変更されていません。"); }
  };
  const submitPin = async () => {
    const normalizedPin = normalizePin(pin);
    if (!/^\d{4,6}$/.test(normalizedPin)) { setPinError("4〜6桁の数字を入力してください"); return; }
    if (pinMode === "setup") {
      const salt = uid(); localStorage.setItem("pinSalt", salt); localStorage.setItem("pinHash", await pinDigest(normalizedPin, salt)); setPinMode("none"); setLocked(false); setPin(""); setPinError(""); return;
    }
    const salt = localStorage.getItem("pinSalt");
    const hash = localStorage.getItem("pinHash");
    if (!salt || !hash) {
      localStorage.removeItem("pinHash");
      localStorage.removeItem("pinSalt");
      setPin("");
      setPinMode("setup");
      setPinError("PIN情報を修復します。新しいPINを設定してください。");
      return;
    }
    if (await pinDigest(normalizedPin, salt) === hash) { setLocked(false); setPinMode("none"); setPin(""); setPinError(""); } else setPinError("PINを確認できません。下の「PINを再設定」から直せます。");
  };
  const resetPin = () => { if (confirm("PINだけを再設定します。作品データは消えません。")) { localStorage.removeItem("pinHash"); localStorage.removeItem("pinSalt"); setPin(""); setPinError(""); setLocked(true); setPinMode("setup"); } };
  const signIn = async (register = false) => {
    if (!supabase) { setCloudMessage("Supabaseの接続情報が未設定です。"); return; }
    setCloudMessage("接続中…");
    const result = register ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
    setCloudMessage(result.error ? result.error.message : register ? "確認メールを送りました。" : "ログインしました。");
  };
  const syncAll = useCallback(async () => {
    if (!supabase || !user) {
      setCloudMessage("先に同期アカウントへログインしてください。");
      setMenu("account");
      return;
    }
    if (!navigator.onLine) {
      setCloudMessage("オフラインです。本文は端末内に保存されています。");
      return;
    }
    if (syncRunning.current) return;
    syncRunning.current = true;
    setCloudMessage("同期中…");
    try {
      const deviceId = localStorage.getItem("deviceId") || uid(); localStorage.setItem("deviceId", deviceId);
      const [localWorks, localChapters, localScenes, localTombstones] = await Promise.all([
        getAll<Work>("works"),
        getAll<Chapter>("chapters"),
        getAll<Scene>("scenes"),
        getAll<Tombstone>("tombstones"),
      ]);
      const [rw, rc, rs, rt] = await Promise.all([
        supabase.from("works").select("*").eq("user_id", user.id),
        supabase.from("chapters").select("*").eq("user_id", user.id),
        supabase.from("scenes").select("*").eq("user_id", user.id),
        supabase.from("deletion_tombstones").select("*").eq("user_id", user.id),
      ]);
      if (rw.error || rc.error || rs.error || rt.error) {
        setCloudMessage("受信できませんでした。原稿は端末内に残っています。");
        return;
      }

      const remoteTombstones: Tombstone[] = (rt.data || []).map(x => ({
        id: `${x.item_type}:${x.item_id}`,
        itemId: x.item_id,
        itemType: x.item_type,
        userId: x.user_id,
        deletedAt: x.deleted_at,
        deviceId: x.device_id,
      }));
      const tombstoneMap = new Map<string, Tombstone>();
      [...localTombstones, ...remoteTombstones].forEach(t => {
        const current = tombstoneMap.get(t.id);
        if (!current || t.deletedAt > current.deletedAt) tombstoneMap.set(t.id, t);
      });
      const tombstones = [...tombstoneMap.values()];
      const deletedWorks = new Set(tombstones.filter(t => t.itemType === "work").map(t => t.itemId));
      const deletedChapters = new Set(tombstones.filter(t => t.itemType === "chapter").map(t => t.itemId));
      const deletedScenes = new Set(tombstones.filter(t => t.itemType === "scene").map(t => t.itemId));

      const activeWorks = localWorks.filter(w => !deletedWorks.has(w.id));
      const activeChapters = localChapters.filter(c => !deletedWorks.has(c.workId) && !deletedChapters.has(c.id));
      const activeScenes = localScenes.filter(s => !deletedWorks.has(s.workId) && !deletedChapters.has(s.chapterId) && !deletedScenes.has(s.id));
      await Promise.all([
        ...localWorks.filter(w => deletedWorks.has(w.id)).map(w => remove("works", w.id)),
        ...localChapters.filter(c => deletedWorks.has(c.workId) || deletedChapters.has(c.id)).map(c => remove("chapters", c.id)),
        ...localScenes.filter(s => deletedWorks.has(s.workId) || deletedChapters.has(s.chapterId) || deletedScenes.has(s.id)).map(s => remove("scenes", s.id)),
        ...tombstones.map(t => put("tombstones", t)),
      ]);

      if (tombstones.length) {
        const { error: tombstoneError } = await supabase.from("deletion_tombstones").upsert(tombstones.map(t => ({
          user_id: user.id,
          item_type: t.itemType,
          item_id: t.itemId,
          deleted_at: t.deletedAt,
          device_id: t.deviceId || deviceId,
        })));
        if (tombstoneError) {
          setCloudMessage("削除情報を送信できませんでした。端末内には保持しています。");
          return;
        }
        await Promise.all(tombstones.filter(t => t.itemType === "scene").map(t => supabase.from("scenes").delete().eq("id", t.itemId).eq("user_id", user.id)));
        await Promise.all(tombstones.filter(t => t.itemType === "chapter").map(t => supabase.from("chapters").delete().eq("id", t.itemId).eq("user_id", user.id)));
        await Promise.all(tombstones.filter(t => t.itemType === "work").map(t => supabase.from("works").delete().eq("id", t.itemId).eq("user_id", user.id)));
      }

      const remoteWorks: Work[] = (rw.data || []).filter(x => !deletedWorks.has(x.id)).map(x => ({ id:x.id,userId:x.user_id,title:x.title,createdAt:x.created_at,updatedAt:x.updated_at,revision:x.revision }));
      const remoteChapters: Chapter[] = (rc.data || []).filter(x => !deletedWorks.has(x.work_id) && !deletedChapters.has(x.id)).map(x => ({ id:x.id,workId:x.work_id,userId:x.user_id,title:x.title,order:x.order,createdAt:x.created_at,updatedAt:x.updated_at,revision:x.revision }));
      const remoteScenes: Scene[] = (rs.data || []).filter(x => !deletedWorks.has(x.work_id) && !deletedChapters.has(x.chapter_id) && !deletedScenes.has(x.id)).map(x => ({ id:x.id,workId:x.work_id,chapterId:x.chapter_id,userId:x.user_id,title:x.title,content:x.content,order:x.order,createdAt:x.created_at,updatedAt:x.updated_at,revision:x.revision,syncStatus:"saved",lastSyncedRevision:x.revision,deviceId:x.device_id }));

      const mergeLatest = <T extends { id:string; updatedAt:string }>(local:T[], remote:T[]) => {
        const merged = new Map(local.map(x => [x.id, x]));
        remote.forEach(x => {
          const current = merged.get(x.id);
          if (!current || x.updatedAt > current.updatedAt) merged.set(x.id, x);
        });
        return [...merged.values()];
      };
      const mergedWorks = mergeLatest(activeWorks, remoteWorks);
      const mergedChapters = mergeLatest(activeChapters, remoteChapters);
      const remoteSceneMap = new Map(remoteScenes.map(s => [s.id, s]));
      const mergedScenes = new Map<string, Scene>();
      for (const local of activeScenes) {
        const remote = remoteSceneMap.get(local.id);
        if (!remote) {
          mergedScenes.set(local.id, local);
          continue;
        }
        const lastSynced = local.lastSyncedRevision || 0;
        const differs = remote.content !== local.content || remote.title !== local.title || remote.order !== local.order;
        const localChanged = differs && local.revision > lastSynced;
        if (localChanged) {
          const result = await saveSceneToCloud(local, remote.revision);
          if (result.status === "saved") {
            mergedScenes.set(local.id, { ...local, updatedAt:result.updatedAt,revision:result.revision,lastSyncedRevision:result.revision,deviceId:result.deviceId,syncStatus:"saved" });
          } else {
            mergedScenes.set(remote.id, remote);
          }
        } else {
          mergedScenes.set(remote.id, remote);
        }
        remoteSceneMap.delete(remote.id);
      }
      remoteSceneMap.forEach(remote => mergedScenes.set(remote.id, remote));

      const ownedWorks = mergedWorks.map(w => ({ id:w.id,user_id:user.id,title:w.title,created_at:w.createdAt,updated_at:w.updatedAt,revision:w.revision }));
      const ownedChapters = mergedChapters.map(c => ({ id:c.id,work_id:c.workId,user_id:user.id,title:c.title,order:c.order,created_at:c.createdAt,updated_at:c.updatedAt,revision:c.revision }));
      const e1 = ownedWorks.length ? await supabase.from("works").upsert(ownedWorks) : { error:null };
      const e2 = ownedChapters.length ? await supabase.from("chapters").upsert(ownedChapters) : { error:null };
      if (e1.error || e2.error) {
        setCloudMessage("送信できませんでした。原稿は端末内に残っています。");
        return;
      }

      for (const scene of mergedScenes.values()) {
        if (remoteScenes.some(remote => remote.id === scene.id)) continue;
        const result = await saveSceneToCloud(scene, 0);
        if (result.status === "saved") {
          mergedScenes.set(scene.id, { ...scene, updatedAt:result.updatedAt,revision:result.revision,lastSyncedRevision:result.revision,deviceId:result.deviceId,syncStatus:scene.syncStatus });
        } else {
          mergedScenes.set(scene.id, { ...scene, syncStatus:"error" });
        }
      }
      const savedScenes = [...mergedScenes.values()];
      await Promise.all([...mergedWorks.map(x=>put("works",x)),...mergedChapters.map(x=>put("chapters",x)),...savedScenes.map(x=>put("scenes",x))]);
      setWorks(mergedWorks); setChapters(mergedChapters); setScenes(savedScenes);
      setCloudMessage("保存・同期しました。もう一方の端末でも「保存・同期する」を押すと、この内容を受信します。");
    } finally {
      syncRunning.current = false;
    }
  }, [supabase, user, saveSceneToCloud]);

  const historyModal = historyOpen && <div className="modalBackdrop"><section className="modal">
    <button className="modalClose" onClick={()=>setHistoryOpen(false)}>×</button>
    <p className="eyebrow">VERSION HISTORY</p>
    <h2>本文の履歴</h2>
    <p className="modalCopy">保存された本文は上書きせず残しています。選んだ時点へいつでも戻せます。</p>
    <div className="historyList">
      {historyVersions.map(version => <article className="sceneRow" key={version.id}>
        <div><h3>{fmt(version.savedAt)}</h3><p>{count(version.content).toLocaleString()}字 · 第{version.revision}版</p><p>{version.content.slice(0,80) || "（空の本文）"}</p></div>
        <button className="secondary" onClick={()=>restoreVersion(version)}>この本文を復元</button>
      </article>)}
      {!historyVersions.length && <p>まだクラウド履歴がありません。</p>}
    </div>
  </section></div>;

  if (!ready) return <div className="loading">書斎を整えています…</div>;
  if (locked) return <div className="lock"><div className="lockMark"><img src="./icon.png" alt="万年筆" /></div><h1>{pinMode === "setup" ? "PINを設定" : "ロック中"}</h1><p>{pinMode === "setup" ? "この端末で使う4〜6桁のPINを決めてください" : "作品名や本文は表示されていません"}</p><input value={pin} onChange={e=>{setPin(normalizePin(e.target.value));setPinError("");}} onKeyDown={e=>e.key==="Enter"&&submitPin()} inputMode="numeric" type="password" placeholder="4〜6桁のPIN" autoFocus/><button onClick={submitPin}>{pinMode === "setup" ? "PINを設定して開く" : "ロックを解除"}</button>{pinMode !== "setup" && <button className="textButton" onClick={resetPin}>PINを再設定</button>}<span className="error">{pinError}</span></div>;
  if (focus && currentScene) return <><div className="focusMode"><Editor scene={currentScene} workCount={workCount} onCommit={commit} onSync={syncAll} onBack={()=>setFocus(false)} onFocus={()=>setFocus(false)} onHistory={openHistory}/></div>{historyModal}</>;
  if (currentScene) return <><Editor scene={currentScene} workCount={workCount} onCommit={commit} onSync={syncAll} onBack={()=>setSceneId(null)} onFocus={setFocus} onHistory={openHistory}/>{historyModal}</>;

  return <div className="appShell">
    <header className="topbar"><button className="brand" onClick={()=>{setWorkId(null);setSceneId(null)}}><img src="./icon.png" alt="" /> 小説執筆</button><nav><button className="headerSyncButton" onClick={syncAll}>保存・同期する</button><button onClick={()=>setMenu("account")}>同期設定</button><button onClick={()=>setMenu("backup")}>バックアップ</button><button onClick={()=>setMenu("settings")}>設定</button>{signOutPath && <a className="signOut" href={signOutPath}>ログアウト</a>}</nav></header>
    {!currentWork ? <main className="library">
      <div className="pageIntro"><div><p className="eyebrow">MY MANUSCRIPTS</p><h1>作品</h1><p>端末に保存済み。オフラインでも執筆できます。</p></div><button className="primary" onClick={createWork}>＋ 新しい作品</button></div>
      <div className="workGrid">{sortedWorks.map(w=><article className="workCard" key={w.id} onClick={()=>chooseWork(w.id)}><div className="bookEdge"/><div><small>{fmt(w.updatedAt)} 更新</small><h2>{w.title}</h2><p>{scenes.filter(s=>s.workId===w.id).reduce((n,s)=>n+count(s.content),0).toLocaleString()}字</p></div><div className="cardActions"><button onClick={e=>{e.stopPropagation();rename("work",w.id,w.title)}}>名前変更</button><button onClick={e=>{e.stopPropagation();deleteItem("work",w.id)}}>削除</button></div></article>)}</div>
    </main> : <main className="chaptersPage">
      <button className="backLink" onClick={()=>setWorkId(null)}>← 作品一覧</button>
      <div className="workTitle"><div><p className="eyebrow">MANUSCRIPT</p><h1>{currentWork.title}</h1><p>全 {workCount.toLocaleString()}字</p></div><button className="secondary" onClick={createChapter}>＋ 章を追加</button></div>
      <div className="chapterList">{chapters.filter(c=>c.workId===workId).sort((a,b)=>a.order-b.order).map(ch=><section className="chapter" key={ch.id}>
        <header><h2>{ch.title}</h2><div><button onClick={()=>rename("chapter",ch.id,ch.title)}>名前変更</button><button onClick={()=>deleteItem("chapter",ch.id)}>削除</button></div></header>
        <div>{scenes.filter(s=>s.chapterId===ch.id).sort((a,b)=>a.order-b.order).map(s=><article className="sceneRow" key={s.id} onClick={()=>chooseScene(s)}><span className="sceneDot"/><div><h3>{s.title}</h3><p>{count(s.content).toLocaleString()}字 · {fmt(s.updatedAt)}</p></div><div className="sceneActions"><button onClick={e=>{e.stopPropagation();moveScene(s,-1)}} aria-label="上へ">↑</button><button onClick={e=>{e.stopPropagation();moveScene(s,1)}} aria-label="下へ">↓</button><button onClick={e=>{e.stopPropagation();rename("scene",s.id,s.title)}}>編集</button><button onClick={e=>{e.stopPropagation();deleteItem("scene",s.id)}}>削除</button></div></article>)}</div>
        <button className="addScene" onClick={()=>createScene(ch.id)}>＋ シーンを追加</button>
      </section>)}</div>
    </main>}
    {menu!=="none" && <div className="modalBackdrop" onMouseDown={()=>setMenu("none")}><section className="modal" onMouseDown={e=>e.stopPropagation()}><button className="modalClose" onClick={()=>setMenu("none")}>×</button>
      {menu==="settings" && <><p className="eyebrow">PREFERENCES</p><h2>執筆設定</h2><label>表示テーマ<select value={settings.theme} onChange={e=>setSettings({...settings,theme:e.target.value as Settings["theme"]})}><option value="system">端末に合わせる</option><option value="light">ライト</option><option value="dark">ダーク</option></select></label><label>文字サイズ <b>{settings.fontSize}px</b><input type="range" min="15" max="24" value={settings.fontSize} onChange={e=>setSettings({...settings,fontSize:+e.target.value})}/></label><label>行間 <b>{settings.lineHeight}</b><input type="range" min="1.5" max="2.4" step=".1" value={settings.lineHeight} onChange={e=>setSettings({...settings,lineHeight:+e.target.value})}/></label><label>本文幅 <b>{settings.width}px</b><input type="range" min="560" max="980" step="20" value={settings.width} onChange={e=>setSettings({...settings,width:+e.target.value})}/></label><label>自動ロック<select value={settings.lockMinutes} onChange={e=>setSettings({...settings,lockMinutes:e.target.value})}><option value="1">1分</option><option value="5">5分</option><option value="15">15分</option><option value="30">30分</option><option value="close">アプリを閉じたときのみ</option></select></label><button className="primary wide" onClick={()=>{setPinMode("setup");setPin("");}}>PINを設定・変更</button>{pinMode==="setup"&&<div className="pinSetup"><input value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,6))} type="password" inputMode="numeric" placeholder="4〜6桁"/><button onClick={submitPin}>設定</button><span>{pinError}</span></div>}</>}
      {menu==="backup" && <><p className="eyebrow">BACKUP</p><h2>原稿を守る</h2><p className="modalCopy">バックアップには認証情報やPINは含まれません。</p><button className="primary wide" onClick={backup}>JSONバックアップを保存</button><button className="secondary wide" onClick={exportTxt} disabled={!currentWork}>現在の作品をTXT保存</button><button className="secondary wide" onClick={()=>fileRef.current?.click()}>JSONから復元</button><input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={e=>e.target.files?.[0]&&restore(e.target.files[0])}/></>}
      {menu==="account" && <><p className="eyebrow">CLOUD SYNC</p><h2>クラウド同期</h2><div className="syncState"><span>●</span><div><b>{user ? `${user.email} で同期できます` : `${accountEmail}で利用中`}</b><p>執筆中はこの端末だけに保存します。「保存・同期する」を押した時だけ、PC・スマホ間で送受信します。</p></div></div>{user ? <><button className="primary wide" onClick={syncAll}>保存・同期する</button><button className="secondary wide" onClick={()=>supabase?.auth.signOut()}>Supabase同期を解除</button></> : <><label>同期用メールアドレス<input value={email} onChange={e=>setEmail(e.target.value)} type="email" placeholder="you@example.com"/></label><label>同期用パスワード<input value={password} onChange={e=>setPassword(e.target.value)} type="password" minLength={8}/></label><button className="primary wide" onClick={()=>signIn(false)}>Supabase同期に接続</button><button className="secondary wide" onClick={()=>signIn(true)}>同期アカウントを新規登録</button></>}{signOutPath && <a className="secondary wide modalSignOut" href={signOutPath}>アプリからログアウト</a>}<p className="finePrint">{cloudMessage || (supabase ? "自動同期はしません。本文は入力中も端末内に自動保存されます。" : "端末間同期はSupabase設定後に利用できます。")}</p></>}
    </section></div>}
  </div>;
}
