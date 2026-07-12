import { useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls } from '@xyflow/react'
import * as signalR from '@microsoft/signalr'
import '@xyflow/react/dist/style.css'

type DesignableType = { namespace: string; name: string; kind: string }
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

// Build a nested namespace tree: "A.B.C" becomes folders A > B > C, with types at their leaf.
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

function NsFolder({ node, depth }: { node: NsNode; depth: number }) {
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
            <NsFolder key={c.name} node={c} depth={depth + 1} />
          ))}
          {types.map((t) => (
            <TypeRow key={t.name} t={t} depth={depth + 1} />
          ))}
        </>
      )}
    </div>
  )
}

function TypeRow({ t, depth }: { t: DesignableType; depth: number }) {
  return (
    <div className="row type" style={{ paddingLeft: depth * 14 + 24 }}>
      <span className={'badge k-' + t.kind} title={t.kind}>
        {shortKind(t.kind)}
      </span>
      <span className="row-label">{t.name}</span>
    </div>
  )
}

export default function App() {
  const conn = useRef<signalR.HubConnection | null>(null)
  const [connected, setConnected] = useState(false)
  const [project, setProject] = useState<ProjectModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const openPath = async (p: string) => {
    if (!conn.current || !p.trim()) return
    setBusy(true)
    setError('')
    setProject(null)
    try {
      setProject(await conn.current.invoke<ProjectModel>('OpenProject', p.trim()))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const c = new signalR.HubConnectionBuilder().withUrl('/hub').build()
    conn.current = c
    c.start()
      .then(() => setConnected(true))
      .catch((e) => setError('connect: ' + e))

    // Native "Browse" result from the Photino host: "project:<path>".
    photino()?.receiveMessage?.((msg) => {
      if (msg.startsWith('project:')) {
        void openPath(msg.slice('project:'.length))
      }
    })

    return () => {
      void c.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const root = useMemo(() => buildTree(project?.types ?? []), [project])
  const topFolders = [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const globalTypes = [...root.types].sort(byKindThenName)

  return (
    <div className="app">
      <header className="topbar">
        <strong>SimulaSharp.Studio</strong>
        <span className="status">{connected ? 'backend connected' : 'connecting…'}</span>
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
          {project && (
            <div className="tree">
              <div className="proj">
                {project.name} — {project.types.length} types
              </div>
              {topFolders.map((c) => (
                <NsFolder key={c.name} node={c} depth={0} />
              ))}
              {globalTypes.map((t) => (
                <TypeRow key={t.name} t={t} depth={0} />
              ))}
            </div>
          )}
        </aside>
        <main className="canvas">
          <ReactFlow defaultNodes={[]} defaultEdges={[]} fitView colorMode="dark">
            <Background />
            <Controls />
          </ReactFlow>
        </main>
      </div>
    </div>
  )
}

function byKindThenName(a: DesignableType, b: DesignableType) {
  const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
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
