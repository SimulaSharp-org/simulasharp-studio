import { useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, type NodeProps } from '@xyflow/react'
import * as signalR from '@microsoft/signalr'
import '@xyflow/react/dist/style.css'

type MemberRow = { name: string; type: string | null; facets: string[] }
type DesignableType = { namespace: string; name: string; kind: string; members: MemberRow[] }
type ProjectModel = { name: string; path: string; types: DesignableType[] }

type NsNode = { name: string; children: Map<string, NsNode>; types: DesignableType[] }

// The Photino native-shell bridge (present only inside the desktop webview, not a plain browser).
type PhotinoBridge = {
  external?: {
    sendMessage?: (msg: string) => void
    receiveMessage?: (cb: (msg: string) => void) => void
  }
}
const photino = () => (window as unknown as PhotinoBridge).external

const KIND_ORDER = ['Model', 'Service', 'LooselyCoupledService', 'Interface', 'Other']
const key = (t: DesignableType) => t.namespace + '.' + t.name

// ── Pending edit journal ────────────────────────────────────────────────────────
// Edits never touch the backend-derived baseline directly; each is an Action appended to a journal.
// The working IR the UI renders is `baseline` folded through the journal — so undo is "drop the last
// action" and discard is "empty the journal". The same journal is what a later Generate step replays
// through Roslyn to write the edits back to source.

type Action =
  | { op: 'renameMember'; typeKey: string; from: string; to: string }
  | { op: 'removeMember'; typeKey: string; name: string }

function applyToType(t: DesignableType, a: Action): DesignableType {
  switch (a.op) {
    case 'renameMember':
      return { ...t, members: t.members.map((m) => (m.name === a.from ? { ...m, name: a.to } : m)) }
    case 'removeMember':
      return { ...t, members: t.members.filter((m) => m.name !== a.name) }
  }
}

function applyAction(model: ProjectModel, a: Action): ProjectModel {
  return { ...model, types: model.types.map((t) => (key(t) === a.typeKey ? applyToType(t, a) : t)) }
}

// ── Left tree ─────────────────────────────────────────────────────────────────

function buildTree(types: DesignableType[]): NsNode {
  const root: NsNode = { name: '', children: new Map(), types: [] }
  for (const t of types) {
    let node = root
    for (const seg of t.namespace ? t.namespace.split('.') : []) {
      let child = node.children.get(seg)
      if (!child) {
        child = { name: seg, children: new Map(), types: [] }
        node.children.set(seg, child)
      }
      node = child
    }
    node.types.push(t)
  }
  return root
}

type TreeProps = { onSelect: (key: string) => void; selectedKey: string | null }

function NsFolder({ node, depth, ...p }: { node: NsNode; depth: number } & TreeProps) {
  const [open, setOpen] = useState(false)
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const types = [...node.types].sort(byKindThenName)
  return (
    <div>
      <div className="row folder" style={{ paddingLeft: depth * 14 + 6 }} onClick={() => setOpen((o) => !o)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="folder-badge">N</span>
        <span className="row-label">{node.name}</span>
      </div>
      {open && (
        <>
          {folders.map((c) => (
            <NsFolder key={c.name} node={c} depth={depth + 1} {...p} />
          ))}
          {types.map((t) => (
            <TypeRow key={t.name} t={t} depth={depth + 1} {...p} />
          ))}
        </>
      )}
    </div>
  )
}

function TypeRow({ t, depth, onSelect, selectedKey }: { t: DesignableType; depth: number } & TreeProps) {
  const selected = key(t) === selectedKey
  return (
    <div
      className={'row type' + (selected ? ' selected' : '')}
      style={{ paddingLeft: depth * 14 + 24 }}
      onClick={() => onSelect(key(t))}
    >
      <span className={'badge k-' + t.kind} title={t.kind}>
        {shortKind(t.kind)}
      </span>
      <span className="row-label">{t.name}</span>
    </div>
  )
}

// ── Canvas: an editable class component box ───────────────────────────────────────

type ClassNodeData = {
  t: DesignableType
  onRename: (from: string, to: string) => void
  onDelete: (name: string) => void
}

/// An inline-editable member name: click to edit, Enter/blur commits, Escape cancels.
function EditableName({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const cancelled = useRef(false)

  if (!editing)
    return (
      <span
        className="mname"
        title="click to rename"
        onClick={() => {
          setText(value)
          cancelled.current = false
          setEditing(true)
        }}
      >
        {value}
      </span>
    )

  return (
    <input
      className="mname-edit"
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (!cancelled.current) onCommit(text)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') {
          cancelled.current = true
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

function ClassNode({ data }: NodeProps) {
  const { t, onRename, onDelete } = data as unknown as ClassNodeData
  return (
    <div className="class-node">
      <div className="class-head">
        <span className={'badge k-' + t.kind} title={t.kind}>
          {shortKind(t.kind)}
        </span>
        <span className="class-name">{t.name}</span>
      </div>
      <div className="class-members">
        {t.members.length === 0 && <div className="member empty">no designable members</div>}
        {[...t.members].sort(byMember).map((m) => (
          <div key={m.name} className="member">
            <span className="mfacets">
              {m.facets.map((f) => (
                <span key={f} className={'mbadge c-' + f} title={f}>
                  {shortCat(f)}
                </span>
              ))}
            </span>
            <EditableName value={m.name} onCommit={(v) => onRename(m.name, v)} />
            {m.type && <span className="mtype">{m.type}</span>}
            <button className="mdel" title="delete member" onClick={() => onDelete(m.name)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const nodeTypes = { classNode: ClassNode }

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const conn = useRef<signalR.HubConnection | null>(null)
  const [connected, setConnected] = useState(false)
  const [baseline, setBaseline] = useState<ProjectModel | null>(null)
  const [journal, setJournal] = useState<Action[]>([])
  const [redo, setRedo] = useState<Action[]>([])
  const [rev, setRev] = useState(0) // bumps on every working-IR change; re-keys the canvas so the box re-renders
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const working = useMemo(() => (baseline ? journal.reduce(applyAction, baseline) : null), [baseline, journal])
  const selected = useMemo(
    () => working?.types.find((t) => key(t) === selectedKey) ?? null,
    [working, selectedKey],
  )
  const root = useMemo(() => buildTree(working?.types ?? []), [working])

  const openPath = async (p: string) => {
    if (!conn.current || !p.trim()) return
    setBusy(true)
    setError('')
    setBaseline(null)
    setSelectedKey(null)
    setJournal([])
    setRedo([])
    setRev(0)
    try {
      setBaseline(await conn.current.invoke<ProjectModel>('OpenProject', p.trim()))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  // Edit commands. dispatch appends an action (clearing the redo stack); undo/redo/discard move
  // between journal and redo. Every one bumps rev so the (uncontrolled) canvas remounts and re-reads.
  const dispatch = (a: Action) => {
    setJournal((j) => [...j, a])
    setRedo([])
    setRev((r) => r + 1)
  }
  const undo = () => {
    if (!journal.length) return
    setRedo([journal[journal.length - 1], ...redo])
    setJournal(journal.slice(0, -1))
    setRev((r) => r + 1)
  }
  const redoFn = () => {
    if (!redo.length) return
    setJournal([...journal, redo[0]])
    setRedo(redo.slice(1))
    setRev((r) => r + 1)
  }
  const discard = () => {
    setJournal([])
    setRedo([])
    setRev((r) => r + 1)
  }

  const onRename = (from: string, to: string) => {
    const t = to.trim()
    if (!t || t === from || !selected || !selectedKey) return
    if (selected.members.some((m) => m.name === t)) return // no duplicate names on one type
    dispatch({ op: 'renameMember', typeKey: selectedKey, from, to: t })
  }
  const onDelete = (name: string) => {
    if (!selectedKey) return
    dispatch({ op: 'removeMember', typeKey: selectedKey, name })
  }

  useEffect(() => {
    const c = new signalR.HubConnectionBuilder().withUrl('/hub').build()
    conn.current = c
    c.start()
      .then(() => setConnected(true))
      .catch((e) => setError('connect: ' + e))

    photino()?.receiveMessage?.((msg) => {
      if (msg.startsWith('project:')) void openPath(msg.slice('project:'.length))
    })

    return () => {
      void c.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo. Re-subscribed on journal/redo so it sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        e.shiftKey ? redoFn() : undo()
      } else if (k === 'y') {
        e.preventDefault()
        redoFn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, redo])

  const nodes = selected
    ? [
        {
          id: selectedKey!,
          type: 'classNode',
          position: { x: 0, y: 0 },
          data: { t: selected, onRename, onDelete } as unknown as Record<string, unknown>,
        },
      ]
    : []

  return (
    <div className="app">
      <header className="topbar">
        <strong>SimulaSharp.Studio</strong>
        <span className="status">{connected ? 'backend connected' : 'connecting…'}</span>
        {baseline && (
          <span className="edits">
            <span className={'pending' + (journal.length ? ' active' : '')}>
              {journal.length ? `${journal.length} pending change${journal.length > 1 ? 's' : ''}` : 'no changes'}
            </span>
            <button onClick={undo} disabled={!journal.length} title="Undo (Ctrl+Z)">
              Undo
            </button>
            <button onClick={redoFn} disabled={!redo.length} title="Redo (Ctrl+Shift+Z)">
              Redo
            </button>
            <button onClick={discard} disabled={!journal.length} title="Discard all pending changes">
              Discard
            </button>
          </span>
        )}
      </header>
      <div className="body">
        <aside className="sidebar">
          <div className="open-row">
            <button
              className="open-project"
              onClick={() => photino()?.sendMessage?.('pickProject')}
              disabled={!connected || busy}
            >
              {busy ? 'Opening…' : 'Open Project'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          {working && (
            <div className="tree">
              <div className="proj">
                {working.name} — {working.types.length} types
              </div>
              {[...root.children.values()]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <NsFolder key={c.name} node={c} depth={0} onSelect={setSelectedKey} selectedKey={selectedKey} />
                ))}
              {[...root.types].sort(byKindThenName).map((t) => (
                <TypeRow key={t.name} t={t} depth={0} onSelect={setSelectedKey} selectedKey={selectedKey} />
              ))}
            </div>
          )}
        </aside>
        <main className="canvas">
          <ReactFlow
            key={(selectedKey ?? 'empty') + ':' + rev}
            defaultNodes={nodes}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ minZoom: 0.5, maxZoom: 1.2 }}
            colorMode="dark"
            nodesConnectable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </main>
      </div>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────────

function byKindThenName(a: DesignableType, b: DesignableType) {
  const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  return k !== 0 ? k : a.name.localeCompare(b.name)
}

const CAT_ORDER = ['Parameter', 'Knob', 'Plottable', 'ServiceRequest', 'ServiceEvent']
function byMember(a: MemberRow, b: MemberRow) {
  const rank = (m: MemberRow) => Math.min(...m.facets.map((f) => CAT_ORDER.indexOf(f)))
  const k = rank(a) - rank(b)
  return k !== 0 ? k : a.name.localeCompare(b.name)
}

function shortKind(kind: string) {
  switch (kind) {
    case 'Model':
      return 'M'
    case 'Service':
      return 'S'
    case 'LooselyCoupledService':
      return 'LC'
    case 'Interface':
      return 'I'
    default:
      return '·'
  }
}

function shortCat(cat: string) {
  switch (cat) {
    case 'Parameter':
      return 'Pa'
    case 'Knob':
      return 'K'
    case 'Plottable':
      return 'Pl'
    case 'ServiceRequest':
      return 'Rq'
    case 'ServiceEvent':
      return 'Ev'
    case 'Property':
      return 'P'
    case 'Method':
      return '()'
    default:
      return '·'
  }
}
