import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type NodeProps,
  type EdgeProps,
  type Node,
  type Edge,
} from '@xyflow/react'
import * as signalR from '@microsoft/signalr'
import '@xyflow/react/dist/style.css'

type MemberRow = { name: string; type: string | null; facets: string[] }
type Association = { kind: string; name: string; target: string }
type DesignableType = {
  namespace: string
  name: string
  kind: string
  members: MemberRow[]
  associations: Association[]
}
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
const key = (t: DesignableType) => (t.namespace ? t.namespace + '.' + t.name : t.name)

// Association layout: each kind sits on one side of the selected type, and each edge is coloured by kind.
const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]
const SIDE_OF: Record<string, Side> = {
  Inheritance: 'top',
  Reference: 'right',
  ServiceDep: 'left',
  Containment: 'bottom',
}
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
const HANDLE_POS: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}
const EDGE_COLOR: Record<string, string> = {
  Inheritance: '#94a3b8',
  Reference: '#38bdf8',
  ServiceDep: '#c084fc',
  Containment: '#34d399',
}

// The attributes a member may carry, gated by its owning type's kind. A member is defined by at
// least one of these. Interfaces are the odd one out — a member is a Property XOR a Method, so its
// attribute set is single-choice (see MemberForm).
const FACETS_BY_KIND: Record<string, string[]> = {
  Model: ['Parameter', 'Knob', 'Plottable'],
  Service: ['Parameter', 'Knob', 'Plottable', 'ServiceRequest', 'ServiceEvent'],
  LooselyCoupledService: ['ServiceRequest', 'ServiceEvent'],
  Interface: ['Property', 'Method'],
  Other: [],
}

// ── Pending edit journal ────────────────────────────────────────────────────────
// Edits never touch the backend-derived baseline directly; each is an Action appended to a journal.
// The working IR the UI renders is `baseline` folded through the journal — so undo is "drop the last
// action" and discard is "empty the journal". The same journal is what a later Generate step replays
// through Roslyn to write the edits back to source.

type Action =
  | { op: 'addMember'; typeKey: string; member: MemberRow }
  | { op: 'updateMember'; typeKey: string; name: string; member: MemberRow }
  | { op: 'removeMember'; typeKey: string; name: string }
  | { op: 'addAssociation'; typeKey: string; assoc: Association }
  | { op: 'renameAssociation'; typeKey: string; ref: Association; to: string }
  | { op: 'removeAssociation'; typeKey: string; ref: Association }

// An association is identified by its (kind, target, name) triple — stable enough since identical
// triples are de-duplicated when the graph is built.
const sameAssoc = (a: Association, b: Association) => a.kind === b.kind && a.target === b.target && a.name === b.name

function applyToType(t: DesignableType, a: Action): DesignableType {
  switch (a.op) {
    case 'addMember':
      return { ...t, members: [...t.members, a.member] }
    case 'updateMember':
      return { ...t, members: t.members.map((m) => (m.name === a.name ? a.member : m)) }
    case 'removeMember':
      return { ...t, members: t.members.filter((m) => m.name !== a.name) }
    case 'addAssociation':
      return { ...t, associations: [...t.associations, a.assoc] }
    case 'renameAssociation':
      return { ...t, associations: t.associations.map((x) => (sameAssoc(x, a.ref) ? { ...x, name: a.to } : x)) }
    case 'removeAssociation':
      return { ...t, associations: t.associations.filter((x) => !sameAssoc(x, a.ref)) }
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

// ── The member mini-form ─────────────────────────────────────────────────────────
// Shared by add (initial null) and edit (initial = the member). Governs name, type and the member's
// attribute set. At least one attribute is required — Save stays disabled until name and ≥1 attribute
// are present, and the last attribute chip cannot be removed.

function MemberForm({
  kind,
  initial,
  onSave,
  onCancel,
}: {
  kind: string
  initial: MemberRow | null
  onSave: (m: MemberRow) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState(initial?.type ?? '')
  const [facets, setFacets] = useState<string[]>(initial?.facets ?? [])

  const catalog = FACETS_BY_KIND[kind] ?? []
  const single = kind === 'Interface' // a member is a Property XOR a Method
  const addable = catalog.filter((f) => !facets.includes(f))
  const valid = name.trim().length > 0 && facets.length > 0

  const commit = () => valid && onSave({ name: name.trim(), type: type.trim() || null, facets })

  return (
    <div className="member-form" onClick={(e) => e.stopPropagation()}>
      <div className="mf-row">
        <input
          className="mf-name"
          placeholder="name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <input
          className="mf-type"
          placeholder="type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </div>
      <div className="mf-facets">
        {single ? (
          <select className="mf-single" value={facets[0] ?? ''} onChange={(e) => setFacets(e.target.value ? [e.target.value] : [])}>
            <option value="">— kind —</option>
            {catalog.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          <>
            {facets.map((f) => (
              <span key={f} className={'mbadge c-' + f} title={f}>
                {f}
                <button
                  className="mf-facet-del"
                  disabled={facets.length <= 1}
                  title={facets.length <= 1 ? 'a member needs at least one attribute' : 'remove attribute'}
                  onClick={() => setFacets(facets.filter((x) => x !== f))}
                >
                  ×
                </button>
              </span>
            ))}
            {addable.length > 0 && (
              <select
                className="mf-add-facet"
                value=""
                onChange={(e) => e.target.value && setFacets([...facets, e.target.value])}
              >
                <option value="">+ attr</option>
                {addable.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      <div className="mf-actions">
        <button className="mf-save" disabled={!valid} onClick={commit}>
          Save
        </button>
        <button className="mf-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Canvas: an editable class component box ───────────────────────────────────────

type ClassNodeData = {
  t: DesignableType
  onAdd: (member: MemberRow) => void
  onUpdate: (name: string, member: MemberRow) => void
  onDelete: (name: string) => void
}

// Hidden connection points on all four sides (source + target each), so association edges can attach to
// a custom node. We never drag-connect — placement of the neighbour conveys the association side.
function NodeHandles() {
  return (
    <>
      {SIDES.map((s) => (
        <Fragment key={s}>
          <Handle id={s + '-s'} type="source" position={HANDLE_POS[s]} className="nh" isConnectable={false} />
          <Handle id={s + '-t'} type="target" position={HANDLE_POS[s]} className="nh" isConnectable={false} />
        </Fragment>
      ))}
    </>
  )
}

/// A compact neighbour node — an associated type shown as a clickable header (click to make it the focus).
function TypeChipNode({ data }: NodeProps) {
  const t = data.t as DesignableType
  return (
    <div className="type-chip">
      <NodeHandles />
      <span className={'badge k-' + t.kind} title={t.kind}>
        {shortKind(t.kind)}
      </span>
      <span className="chip-name">{t.name}</span>
    </div>
  )
}

// ── Association edge (interactive label: rename a named edge, delete any edge) ─────

type AssocEdgeData = {
  kind: string
  name: string
  onRename: (to: string) => void
  onDelete: () => void
}

function AssocEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const d = data as unknown as AssocEdgeData
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(d.name)
  const cancelled = useRef(false)
  const nameable = d.kind !== 'Inheritance'

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="edge-label"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            borderColor: EDGE_COLOR[d.kind],
          }}
        >
          {editing ? (
            <input
              className="edge-name-edit"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                setEditing(false)
                if (!cancelled.current && text.trim() && text.trim() !== d.name) d.onRename(text.trim())
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                else if (e.key === 'Escape') {
                  cancelled.current = true
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
          ) : (
            <span
              className={'edge-name' + (nameable ? ' editable' : '')}
              title={nameable ? 'click to rename' : d.kind}
              onClick={() => {
                if (!nameable) return
                setText(d.name)
                cancelled.current = false
                setEditing(true)
              }}
            >
              {d.name || (d.kind === 'Inheritance' ? '▷' : '')}
            </span>
          )}
          <button className="edge-del" title="delete association" onClick={d.onDelete}>
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const edgeTypes = { assoc: AssocEdge }

// ── Add-association stub: a "+" on a dangling edge that expands, in place, into a form ─────────────

type AddStubData = {
  side: Side
  kind: string
  candidates: DesignableType[] // valid targets for this kind
  onAdd: (assoc: Association) => void
}

function AddStubNode({ data }: NodeProps) {
  const d = data as unknown as AddStubData
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const named = d.kind !== 'Inheritance'
  const valid = target !== '' && (!named || name.trim().length > 0)

  if (!open)
    return (
      <div className="add-stub">
        <NodeHandles />
        <button className="add-stub-btn" title={'add ' + d.kind} onClick={() => setOpen(true)}>
          +
        </button>
      </div>
    )

  return (
    <div className="add-stub open">
      <NodeHandles />
      <div className="stub-form" onClick={(e) => e.stopPropagation()}>
        <div className="stub-kind" style={{ color: EDGE_COLOR[d.kind] }}>
          {d.kind}
        </div>
        <select className="stub-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">target…</option>
          {d.candidates.map((c) => (
            <option key={key(c)} value={key(c)}>
              {c.name}
            </option>
          ))}
        </select>
        {named && (
          <input className="stub-name" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <div className="stub-actions">
          <button
            className="mf-save"
            disabled={!valid}
            onClick={() => valid && d.onAdd({ kind: d.kind, name: named ? name.trim() : '', target })}
          >
            Add
          </button>
          <button className="mf-cancel" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function ClassNode({ data }: NodeProps) {
  const { t, onAdd, onUpdate, onDelete } = data as unknown as ClassNodeData
  const [editing, setEditing] = useState<string | null>(null) // member name whose form is open
  const [adding, setAdding] = useState(false)
  const canAdd = (FACETS_BY_KIND[t.kind] ?? []).length > 0

  return (
    <div className="class-node">
      <NodeHandles />
      <div className="class-head">
        <span className={'badge k-' + t.kind} title={t.kind}>
          {shortKind(t.kind)}
        </span>
        <span className="class-name">{t.name}</span>
      </div>
      <div className="class-members">
        {t.members.length === 0 && !adding && <div className="member empty">no designable members</div>}
        {[...t.members].sort(byMember).map((m) => (
          <div key={m.name}>
            <div className="member">
              <span className="mfacets">
                {m.facets.map((f) => (
                  <span key={f} className={'mbadge c-' + f} title={f}>
                    {shortCat(f)}
                  </span>
                ))}
              </span>
              <span
                className="mname"
                title="click to edit"
                onClick={() => {
                  setAdding(false)
                  setEditing((cur) => (cur === m.name ? null : m.name))
                }}
              >
                {m.name}
              </span>
              {m.type && <span className="mtype">{m.type}</span>}
              <button className="mdel" title="delete member" onClick={() => onDelete(m.name)}>
                ×
              </button>
            </div>
            {editing === m.name && (
              <MemberForm
                kind={t.kind}
                initial={m}
                onSave={(nm) => {
                  setEditing(null)
                  onUpdate(m.name, nm)
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        ))}
      </div>
      {canAdd && (
        <div className="class-foot">
          {adding ? (
            <MemberForm
              kind={t.kind}
              initial={null}
              onSave={(nm) => {
                setAdding(false)
                onAdd(nm)
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              className="add-member"
              onClick={() => {
                setEditing(null)
                setAdding(true)
              }}
            >
              + member
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const nodeTypes = { classNode: ClassNode, typeChip: TypeChipNode, addStub: AddStubNode }

type GraphHandlers = Omit<ClassNodeData, 't'> & {
  allTypes: DesignableType[]
  onAddAssoc: (assoc: Association) => void
  onRenameAssoc: (ref: Association, to: string) => void
  onDeleteAssoc: (ref: Association) => void
}

/// Valid target types for a new association of the given kind (services/interfaces for a service-dep;
/// any other type otherwise), excluding the type itself.
function candidatesFor(kind: string, allTypes: DesignableType[], selKey: string) {
  const pool = allTypes.filter((t) => key(t) !== selKey)
  if (kind === 'ServiceDep')
    return pool.filter((t) => t.kind === 'Service' || t.kind === 'LooselyCoupledService' || t.kind === 'Interface')
  return pool
}

// Builds the focus graph: the selected type as an editable class box at the origin, its resolvable
// associations as neighbour chips (with one coloured, editable edge each), and a dangling "+" add-stub
// on every side that expands in place into an add-association form.
function buildGraph(sel: DesignableType, byKey: Map<string, DesignableType>, h: GraphHandlers): { nodes: Node[]; edges: Edge[] } {
  const selKey = key(sel)
  const nodes: Node[] = [
    { id: selKey, type: 'classNode', position: { x: 0, y: 0 }, data: { t: sel, onAdd: h.onAdd, onUpdate: h.onUpdate, onDelete: h.onDelete } as unknown as Record<string, unknown> },
  ]
  const edges: Edge[] = []

  // Resolve edges to targets that exist as nodes; each unique target gets one chip, placed by the side
  // of its first association (all its edges still connect to that one chip).
  const nodeSide = new Map<string, Side>()
  const resolved: Association[] = []
  for (const a of sel.associations) {
    const side = SIDE_OF[a.kind]
    if (!side || a.target === selKey || !byKey.has(a.target)) continue
    if (!nodeSide.has(a.target)) nodeSide.set(a.target, side)
    resolved.push(a)
  }

  // Per side: neighbour chips first, then one add-stub in the trailing slot (so a bare side shows just
  // its "+"). Count includes the stub, so everything stays centered together.
  const bySide: Record<Side, string[]> = { top: [], right: [], bottom: [], left: [] }
  for (const [tk, side] of nodeSide) bySide[side].push(tk)
  const addSides = ADD_SIDES_BY_KIND[sel.kind] ?? []
  for (const side of SIDES) {
    const showStub = addSides.includes(side)
    const count = bySide[side].length + (showStub ? 1 : 0)
    bySide[side].forEach((tk, i) => {
      nodes.push({ id: tk, type: 'typeChip', position: placeSide(side, i, count), data: { t: byKey.get(tk)! } })
    })
    if (!showStub) continue
    const kind = KIND_OF_SIDE[side]
    nodes.push({
      id: 'stub:' + side,
      type: 'addStub',
      position: placeSide(side, bySide[side].length, count),
      data: { side, kind, candidates: candidatesFor(kind, h.allTypes, selKey), onAdd: h.onAddAssoc } as unknown as Record<string, unknown>,
    })
    edges.push({
      id: 'stub-e:' + side,
      source: selKey,
      target: 'stub:' + side,
      sourceHandle: side + '-s',
      targetHandle: OPPOSITE[side] + '-t',
      style: { stroke: '#334155', strokeWidth: 1, strokeDasharray: '4 4' },
    })
  }

  resolved.forEach((a, i) => {
    const side = nodeSide.get(a.target)!
    const color = EDGE_COLOR[a.kind]
    edges.push({
      id: 'e' + i,
      type: 'assoc',
      source: selKey,
      target: a.target,
      sourceHandle: side + '-s',
      targetHandle: OPPOSITE[side] + '-t',
      style: { stroke: color, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      data: {
        kind: a.kind,
        name: a.name,
        onRename: (to: string) => h.onRenameAssoc(a, to),
        onDelete: () => h.onDeleteAssoc(a),
      } as unknown as Record<string, unknown>,
    })
  })

  return { nodes, edges }
}

// Which association kind each side creates.
const KIND_OF_SIDE: Record<Side, string> = { top: 'Inheritance', right: 'Reference', left: 'ServiceDep', bottom: 'Containment' }

// Which associations a type may *own*, so add-stubs only appear where they're legal:
//   containment / references are model-only decorators; a [ServiceRef] lives on a model or a service;
//   inheritance is universal; an interface only extends other interfaces.
// Sides: top = Inheritance, right = Reference, bottom = Containment, left = ServiceDep.
const ADD_SIDES_BY_KIND: Record<string, Side[]> = {
  Model: ['top', 'right', 'bottom', 'left'],
  Service: ['top', 'left'],
  LooselyCoupledService: ['top', 'left'],
  Interface: ['top'],
  Other: [],
}

function placeSide(side: Side, i: number, n: number) {
  const spreadX = (i - (n - 1) / 2) * 250
  const spreadY = (i - (n - 1) / 2) * 110
  switch (side) {
    case 'top':
      return { x: spreadX, y: -170 }
    case 'bottom':
      return { x: spreadX, y: 340 }
    case 'right':
      return { x: 370, y: spreadY }
    case 'left':
      return { x: -270, y: spreadY }
  }
}

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
  const [genMsg, setGenMsg] = useState('')

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
    setGenMsg('')
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

  // Generate: replay the pending journal into source. On success the backend returns the freshly
  // re-derived IR, which becomes the new baseline (clearing the journal); on failure it writes nothing
  // and returns the blocking errors.
  const generate = async () => {
    if (!conn.current || !baseline || !journal.length) return
    setGenMsg('Generating…')
    setError('')
    try {
      const res = await conn.current.invoke<{ ok: boolean; errors: string[]; model: ProjectModel | null }>(
        'Generate',
        baseline.path,
        journal,
      )
      if (res.ok && res.model) {
        setBaseline(res.model)
        setJournal([])
        setRedo([])
        setRev((r) => r + 1)
        setGenMsg('Generated ✓')
      } else {
        setGenMsg('Generate failed')
        setError(res.errors.join('\n') || 'unknown error')
      }
    } catch (e) {
      setGenMsg('')
      setError(String(e))
    }
  }

  const onAdd = (member: MemberRow) => {
    if (!selectedKey || !selected) return
    if (selected.members.some((m) => m.name === member.name)) return // no duplicate names on one type
    dispatch({ op: 'addMember', typeKey: selectedKey, member })
  }
  const onUpdate = (name: string, member: MemberRow) => {
    if (!selectedKey || !selected) return
    if (member.name !== name && selected.members.some((m) => m.name === member.name)) return // renamed onto an existing member
    dispatch({ op: 'updateMember', typeKey: selectedKey, name, member })
  }
  const onDelete = (name: string) => {
    if (!selectedKey) return
    dispatch({ op: 'removeMember', typeKey: selectedKey, name })
  }

  const onAddAssoc = (assoc: Association) => {
    if (!selectedKey || !selected) return
    if (selected.associations.some((x) => sameAssoc(x, assoc))) return // already there
    dispatch({ op: 'addAssociation', typeKey: selectedKey, assoc })
  }
  const onRenameAssoc = (ref: Association, to: string) => {
    if (!selectedKey || !selected) return
    if (selected.associations.some((x) => x.kind === ref.kind && x.target === ref.target && x.name === to)) return // dup
    dispatch({ op: 'renameAssociation', typeKey: selectedKey, ref, to })
  }
  const onDeleteAssoc = (ref: Association) => {
    if (!selectedKey) return
    dispatch({ op: 'removeAssociation', typeKey: selectedKey, ref })
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

  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo — but never while a text field is focused, so
  // in-form text undo stays native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
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

  const byKey = useMemo(() => new Map((working?.types ?? []).map((t) => [key(t), t])), [working])
  const { nodes, edges } = selected
    ? buildGraph(selected, byKey, {
        onAdd,
        onUpdate,
        onDelete,
        allTypes: working?.types ?? [],
        onAddAssoc,
        onRenameAssoc,
        onDeleteAssoc,
      })
    : { nodes: [], edges: [] }

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
            <button className="gen" onClick={generate} disabled={!journal.length} title="Write pending changes back to source">
              Generate
            </button>
            {genMsg && <span className="gen-msg">{genMsg}</span>}
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
            defaultEdges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, node) => node.type === 'typeChip' && node.id !== selectedKey && setSelectedKey(node.id)}
            fitView
            fitViewOptions={{ minZoom: 0.4, maxZoom: 1.2 }}
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
