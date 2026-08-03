"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type User } from "@supabase/supabase-js";

type Work = { id: string; userId: string; title: string; createdAt: string; updatedAt: string; revision: number };
type Chapter = { id: string; workId: string; userId: string; title: string; order: number; createdAt: string; updatedAt: string; revision: number };
type SyncStatus = "saved" | "saving" | "offline" | "error" | "conflict";
type Scene = { id: string; workId: string; chapterId: string; userId: string; title: string; content: string; order: number; createdAt: string; updatedAt: string; revision: number; syncStatus: SyncStatus };
type Settings = { theme: "system" | "light" | "dark"; fontSize: number; lineHeight: number; width: number; lockMinutes: string; reopen: boolean; showStatus: boolean };
type Snapshot = { version: 1; exportedAt: string; works: Work[]; chapters: Chapter[]; scenes: Scene[]; settings: Settings };

const DB_NAME = "shizuku-writer";
const STORE_NAMES = ["works", "chapters", "scenes"] as const;
const DEFAULT_SETTINGS: Settings = { theme: "system", fontSize: 18, lineHeight: 1.9, width: 760, lockMinutes: "5", reopen: true, showStatus: true };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const count = (text: string) => Array.from(text).length;
const fmt = (iso: string) => new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
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

function Editor({ scene, workCount, onCommit, onBack, onFocus }: { scene: Scene; workCount: number; onCommit: (content: string, status: SyncStatus) => void; onBack: () => void; onFocus: (value: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useRef(scene.content);
  const composing = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<SyncStatus>(scene.syncStatus);
  const [chars, setChars] = useState(count(scene.content));

  const schedule = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setStatus(navigator.onLine ? "saving" : "offline");
    saveTimer.current = setTimeout(() => {
      const next = navigator.onLine ? "saved" : "offline";
      setStatus(next);
      onCommit(draft.current, next);
      const el = ref.current;
      if (el) localStorage.setItem(`cursor:${scene.id}`, JSON.stringify({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }));
    }, 400);
  }, [onCommit, scene.id]);

  useEffect(() => {
    draft.current = scene.content;
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
      onCommit(draft.current, navigator.onLine ? "saved" : "offline");
    };
  }, [scene.id]); // Deliberately never resets textarea while typing.

  return (
    <main className="editorShell">
      <header className="editorBar">
        <button className="iconButton" onClick={onBack} aria-label="一覧へ戻る">←</button>
        <div className="sceneHeading"><span>{scene.title}</span><small>{status === "saving" ? "保存中…" : status === "saved" ? "保存済み" : status === "offline" ? "オフライン・端末に保存" : status === "conflict" ? "競合あり" : "同期エラー"}</small></div>
        <button className="focusButton" onClick={() => onFocus(true)}>集中</button>
      </header>
      <textarea
        ref={ref}
        className="manuscript"
        defaultValue={scene.content}
        aria-label="本文"
        spellCheck={false}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionUpdate={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; draft.current = e.currentTarget.value; setChars(count(draft.current)); schedule(); }}
        onInput={(e) => {
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

export function WriterApp({ accountEmail, signOutPath }: { accountEmail: string; signOutPath: string }) {
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
  const [settings, setSettings] = useState<Settings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("writerSettings") || "{}") }; } catch { return DEFAULT_SETTINGS; }
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supabase = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return url && key ? createClient(url, key) : null;
  }, []);

  useEffect(() => {
    (async () => {
      let [w, c, s] = await Promise.all([getAll<Work>("works"), getAll<Chapter>("chapters"), getAll<Scene>("scenes")]);
      if (!w.length) {
        const t = now(), wid = uid(), cid = uid(), sid = uid();
        w = [{ id: wid, userId: "local", title: "夜の森で、あなたを待つ", createdAt: t, updatedAt: t, revision: 1 }];
        c = [{ id: cid, workId: wid, userId: "local", title: "第1章　はじまり", order: 0, createdAt: t, updatedAt: t, revision: 1 }];
        s = [{ id: sid, workId: wid, chapterId: cid, userId: "local", title: "シーン1", content: "雨の匂いが、まだ窓辺に残っていた。\n\n", order: 0, createdAt: t, updatedAt: t, revision: 1, syncStatus: "saved" }];
        await Promise.all([put("works", w[0]), put("chapters", c[0]), put("scenes", s[0])]);
      }
      setWorks(w); setChapters(c); setScenes(s);
      const lastWork = localStorage.getItem("lastWorkId");
      const lastScene = localStorage.getItem("lastSceneId");
      if (settings.reopen && w.some(x => x.id === lastWork)) setWorkId(lastWork);
      if (settings.reopen && s.some(x => x.id === lastScene)) setSceneId(lastScene);
      const hasPin = Boolean(localStorage.getItem("pinHash"));
      setLocked(hasPin); setPinMode(hasPin ? "unlock" : "none"); setReady(true);
    })().catch(() => setReady(true));
    navigator.serviceWorker?.register("/sw.js");
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
  const commit = useCallback(async (content: string, syncStatus: SyncStatus) => {
    if (!sceneId) return;
    const updatedAt = now();
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, content, updatedAt, revision: s.revision + 1, syncStatus } : s));
    const old = scenes.find(s => s.id === sceneId);
    if (old) {
      const next = { ...old, content, updatedAt, revision: old.revision + 1, syncStatus };
      await put("scenes", next);
      if (supabase && user && navigator.onLine) {
        if (syncTimer.current) clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(async () => {
          const { error } = await supabase.from("scenes").upsert({
            id: next.id, work_id: next.workId, chapter_id: next.chapterId, user_id: user.id,
            title: next.title, content: next.content, order: next.order, updated_at: next.updatedAt,
            revision: next.revision, device_id: localStorage.getItem("deviceId"), last_synced_revision: next.revision
          });
          setScenes(v => v.map(x => x.id === next.id ? { ...x, syncStatus: error ? "error" : "saved" } : x));
        }, 2000);
      }
    }
  }, [sceneId, scenes, supabase, user]);
  const rename = async (kind: "work" | "chapter" | "scene", id: string, old: string) => {
    const title = prompt("新しいタイトル", old)?.trim(); if (!title) return;
    if (kind === "work") { const item = works.find(x => x.id === id)!; const next = { ...item, title, updatedAt: now(), revision: item.revision + 1 }; setWorks(v => v.map(x => x.id === id ? next : x)); await put("works", next); }
    if (kind === "chapter") { const item = chapters.find(x => x.id === id)!; const next = { ...item, title, updatedAt: now(), revision: item.revision + 1 }; setChapters(v => v.map(x => x.id === id ? next : x)); await put("chapters", next); }
    if (kind === "scene") { const item = scenes.find(x => x.id === id)!; const next = { ...item, title, updatedAt: now(), revision: item.revision + 1 }; setScenes(v => v.map(x => x.id === id ? next : x)); await put("scenes", next); }
  };
  const deleteItem = async (kind: "work" | "chapter" | "scene", id: string) => {
    if (!confirm("削除しますか？ この操作は元に戻せません。")) return;
    if (kind === "scene") { await remove("scenes", id); setScenes(v => v.filter(x => x.id !== id)); }
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
      if (replace) await Promise.all(STORE_NAMES.map(clearStore));
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
    if (!/^\d{4,6}$/.test(pin)) { setPinError("4〜6桁の数字を入力してください"); return; }
    if (pinMode === "setup") {
      const salt = uid(); localStorage.setItem("pinSalt", salt); localStorage.setItem("pinHash", await pinDigest(pin, salt)); setPinMode("none"); setLocked(false); setPin(""); return;
    }
    const salt = localStorage.getItem("pinSalt") || ""; if (await pinDigest(pin, salt) === localStorage.getItem("pinHash")) { setLocked(false); setPinMode("none"); setPin(""); setPinError(""); } else setPinError("PINが違います");
  };
  const resetPin = () => { if (confirm("PINだけをリセットします。作品データは消えません。")) { localStorage.removeItem("pinHash"); localStorage.removeItem("pinSalt"); setLocked(false); setPinMode("none"); } };
  const signIn = async (register = false) => {
    if (!supabase) { setCloudMessage("Supabaseの接続情報が未設定です。"); return; }
    setCloudMessage("接続中…");
    const result = register ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
    setCloudMessage(result.error ? result.error.message : register ? "確認メールを送りました。" : "ログインしました。");
  };
  const syncAll = async () => {
    if (!supabase || !user) return;
    setCloudMessage("同期中…");
    const deviceId = localStorage.getItem("deviceId") || uid(); localStorage.setItem("deviceId", deviceId);
    const ownedWorks = works.map(w => ({ id:w.id,user_id:user.id,title:w.title,created_at:w.createdAt,updated_at:w.updatedAt,revision:w.revision }));
    const ownedChapters = chapters.map(c => ({ id:c.id,work_id:c.workId,user_id:user.id,title:c.title,order:c.order,created_at:c.createdAt,updated_at:c.updatedAt,revision:c.revision }));
    const ownedScenes = scenes.map(s => ({ id:s.id,work_id:s.workId,chapter_id:s.chapterId,user_id:user.id,title:s.title,content:s.content,order:s.order,created_at:s.createdAt,updated_at:s.updatedAt,revision:s.revision,device_id:deviceId,last_synced_revision:s.revision }));
    const e1 = await supabase.from("works").upsert(ownedWorks), e2 = await supabase.from("chapters").upsert(ownedChapters), e3 = await supabase.from("scenes").upsert(ownedScenes);
    if (e1.error || e2.error || e3.error) setCloudMessage("同期できませんでした。原稿は端末内に残っています。");
    else { setCloudMessage("すべて同期しました。"); setScenes(v=>v.map(s=>({...s,syncStatus:"saved"}))); }
  };

  if (!ready) return <div className="loading">書斎を整えています…</div>;
  if (locked) return <div className="lock"><div className="lockMark">雫</div><h1>ロック中</h1><p>作品名や本文は表示されていません</p><input value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,6))} onKeyDown={e=>e.key==="Enter"&&submitPin()} inputMode="numeric" type="password" placeholder="PIN" autoFocus/><button onClick={submitPin}>ロックを解除</button><button className="textButton" onClick={resetPin}>PINを忘れた場合</button><span className="error">{pinError}</span></div>;
  if (focus && currentScene) return <div className="focusMode"><Editor scene={currentScene} workCount={workCount} onCommit={commit} onBack={()=>setFocus(false)} onFocus={()=>setFocus(false)}/></div>;
  if (currentScene) return <Editor scene={currentScene} workCount={workCount} onCommit={commit} onBack={()=>setSceneId(null)} onFocus={setFocus}/>;

  return <div className="appShell">
    <header className="topbar"><button className="brand" onClick={()=>{setWorkId(null);setSceneId(null)}}><img src="/icon.png" alt="" /> 小説執筆</button><nav><button onClick={()=>setMenu("account")}>同期</button><button onClick={()=>setMenu("backup")}>保存</button><button onClick={()=>setMenu("settings")}>設定</button><a className="signOut" href={signOutPath}>ログアウト</a></nav></header>
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
      {menu==="account" && <><p className="eyebrow">CLOUD SYNC</p><h2>クラウド同期</h2><div className="syncState"><span>●</span><div><b>{user ? `${user.email} で同期中` : `${accountEmail} でアプリにログイン中`}</b><p>アプリをログアウトすると、再認証するまで作品名や本文は表示されません。</p></div></div>{user ? <><button className="primary wide" onClick={syncAll}>今すぐすべて同期</button><button className="secondary wide" onClick={()=>supabase?.auth.signOut()}>Supabase同期を解除</button></> : <><label>同期用メールアドレス<input value={email} onChange={e=>setEmail(e.target.value)} type="email" placeholder="you@example.com"/></label><label>同期用パスワード<input value={password} onChange={e=>setPassword(e.target.value)} type="password" minLength={8}/></label><button className="primary wide" onClick={()=>signIn(false)}>Supabase同期に接続</button><button className="secondary wide" onClick={()=>signIn(true)}>同期アカウントを新規登録</button></>}<a className="secondary wide modalSignOut" href={signOutPath}>アプリからログアウト</a><p className="finePrint">{cloudMessage || (supabase ? "同期は入力停止から約2秒後に行われます。" : "端末間同期はSupabase設定後に利用できます。")}</p></>}
    </section></div>}
  </div>;
}
