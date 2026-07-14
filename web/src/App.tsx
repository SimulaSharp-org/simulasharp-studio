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

type MemberRow = { name: string; type: string | null; facets: string[]; params?: string | null }
type Association = { kind: string; name: string; target: string }
type DesignableType = {
  namespace: string
  name: string
  kind: string
  members: MemberRow[]
  associations: Association[]
}
type ProjectModel = { name: string; path: string; types: DesignableType[] }

// ── Assembly topology (read-only for now) ───────────────────────────────────────
type DepBinding = { member: string; service: string }
// isCross tags the binding's kind so write-back files it under the right YAML block: false → intra-site [Reference<T>]
// (Refs:), true → cross-site [CrossReference<T>] (CRefs:). Defaults to false when omitted (legacy single-kind actions).
type ReferenceBinding = { name: string; targets: string[]; isCross?: boolean }
type Container = { name: string; children: ModelInstance[] }
type ModelInstance = { name: string; type: string; config: Record<string, string>; containers: Container[]; refs: ReferenceBinding[]; deps: DepBinding[] }
type ServiceInstance = { name: string; type: string; config: Record<string, string>; deps: DepBinding[] }
type SiteInstance = { name: string; maxEvents: number; models: ModelInstance[] }
type AssemblyModel = { name: string; missionStart: string | null; services: ServiceInstance[]; sites: SiteInstance[]; path: string }

// Topology edit journal (asm = the assembly file path). Renames/removes of a service cascade through the
// instance tree's [ServiceRef] deps so the YAML never dangles.
type TopoAction =
  | { op: 'renameSimulator'; asm: string; to: string }
  | { op: 'addSite'; asm: string; name: string }
  | { op: 'removeSite'; asm: string; name: string }
  | { op: 'renameSite'; asm: string; from: string; to: string }
  | { op: 'setSiteMaxEvents'; asm: string; name: string; maxEvents: number }
  | { op: 'addService'; asm: string; name: string; type: string }
  | { op: 'removeService'; asm: string; name: string }
  | { op: 'renameService'; asm: string; from: string; to: string }
  | { op: 'setServiceConfig'; asm: string; name: string; key: string; value: string }
  // instance-tree edits — path is the dotted instance path (Sim.Root.Child…, containers/sites transparent)
  | { op: 'addRootModel'; asm: string; site: string; name: string; type: string }
  | { op: 'addInstance'; asm: string; parentPath: string; container: string; name: string; type: string }
  | { op: 'moveInstance'; asm: string; path: string; toParentPath: string; toContainer: string }
  | { op: 'removeInstance'; asm: string; path: string }
  | { op: 'setInstanceConfig'; asm: string; path: string; key: string; value: string }
  // reference/dep wiring — `name`/`member` name a [Reference<T>]/[CrossReference<T>]/[ServiceRef] field on the
  // instance's type. `isCross` files the binding under Refs: (false) vs CRefs: (true).
  | { op: 'setReference'; asm: string; path: string; name: string; targets: string[]; isCross: boolean }
  | { op: 'setServiceDep'; asm: string; path: string; member: string; service: string }

const mapDeps = (models: ModelInstance[], fn: (d: DepBinding) => DepBinding | null): ModelInstance[] =>
  models.map((m) => ({
    ...m,
    deps: m.deps.map(fn).filter((d): d is DepBinding => d !== null),
    containers: m.containers.map((c) => ({ ...c, children: mapDeps(c.children, fn) })),
  }))

function applyTopoToAsm(asm: AssemblyModel, a: TopoAction): AssemblyModel {
  switch (a.op) {
    case 'renameSimulator':
      return { ...asm, name: a.to }
    case 'addSite':
      return { ...asm, sites: [...asm.sites, { name: a.name, maxEvents: 64, models: [] }] }
    case 'removeSite':
      return { ...asm, sites: asm.sites.filter((s) => s.name !== a.name) }
    case 'renameSite':
      return { ...asm, sites: asm.sites.map((s) => (s.name === a.from ? { ...s, name: a.to } : s)) }
    case 'setSiteMaxEvents':
      return { ...asm, sites: asm.sites.map((s) => (s.name === a.name ? { ...s, maxEvents: a.maxEvents } : s)) }
    case 'addService':
      return { ...asm, services: [...asm.services, { name: a.name, type: a.type, config: {}, deps: [] }] }
    case 'removeService':
      return {
        ...asm,
        services: asm.services.filter((s) => s.name !== a.name),
        sites: asm.sites.map((s) => ({ ...s, models: mapDeps(s.models, (d) => (d.service === a.name ? null : d)) })),
      }
    case 'renameService':
      return {
        ...asm,
        services: asm.services.map((s) => (s.name === a.from ? { ...s, name: a.to } : s)),
        sites: asm.sites.map((s) => ({ ...s, models: mapDeps(s.models, (d) => (d.service === a.from ? { ...d, service: a.to } : d)) })),
      }
    case 'setServiceConfig':
      return { ...asm, services: asm.services.map((s) => (s.name === a.name ? { ...s, config: { ...s.config, [a.key]: a.value } } : s)) }
    case 'addRootModel': {
      const root: ModelInstance = { name: a.name, type: a.type, config: {}, containers: [], refs: [], deps: [] }
      return { ...asm, sites: asm.sites.map((s) => (s.name === a.site ? { ...s, models: [...s.models, root] } : s)) }
    }
    case 'addInstance': {
      const segs = pathSegs(a.parentPath, asm.name)
      const child: ModelInstance = { name: a.name, type: a.type, config: {}, containers: [], refs: [], deps: [] }
      const add = (m: ModelInstance): ModelInstance =>
        m.containers.some((c) => c.name === a.container)
          ? { ...m, containers: m.containers.map((c) => (c.name === a.container ? { ...c, children: [...c.children, child] } : c)) }
          : { ...m, containers: [...m.containers, { name: a.container, children: [child] }] }
      return { ...asm, sites: asm.sites.map((s) => ({ ...s, models: mapInstanceAt(s.models, segs, add) })) }
    }
    case 'moveInstance': {
      const fromSegs = pathSegs(a.path, asm.name)
      const parentSegs = pathSegs(a.toParentPath, asm.name)
      const insert = (m: ModelInstance): ModelInstance =>
        m.containers.some((c) => c.name === a.toContainer)
          ? { ...m, containers: m.containers.map((c) => (c.name === a.toContainer ? { ...c, children: [...c.children, moved!] } : c)) }
          : { ...m, containers: [...m.containers, { name: a.toContainer, children: [moved!] }] }
      let moved: ModelInstance | null = null
      return {
        ...asm,
        sites: asm.sites.map((s) => {
          const found = findInstanceAt(s.models, fromSegs)
          if (!found) return s // the instance lives in another site — leave this one untouched
          moved = found
          return { ...s, models: mapInstanceAt(removeInstanceAt(s.models, fromSegs), parentSegs, insert) }
        }),
      }
    }
    case 'removeInstance':
      return { ...asm, sites: asm.sites.map((s) => ({ ...s, models: removeInstanceAt(s.models, pathSegs(a.path, asm.name)) })) }
    case 'setInstanceConfig': {
      const segs = pathSegs(a.path, asm.name)
      const set = (m: ModelInstance): ModelInstance => ({ ...m, config: { ...m.config, [a.key]: a.value } })
      return { ...asm, sites: asm.sites.map((s) => ({ ...s, models: mapInstanceAt(s.models, segs, set) })) }
    }
    case 'setReference': {
      const segs = pathSegs(a.path, asm.name)
      const set = (m: ModelInstance): ModelInstance => {
        const refs = !a.targets.length
          ? m.refs.filter((r) => r.name !== a.name)
          : m.refs.some((r) => r.name === a.name)
            ? m.refs.map((r) => (r.name === a.name ? { ...r, targets: a.targets, isCross: a.isCross } : r))
            : [...m.refs, { name: a.name, targets: a.targets, isCross: a.isCross }]
        return { ...m, refs }
      }
      return { ...asm, sites: asm.sites.map((s) => ({ ...s, models: mapInstanceAt(s.models, segs, set) })) }
    }
    case 'setServiceDep': {
      const segs = pathSegs(a.path, asm.name)
      const set = (m: ModelInstance): ModelInstance => {
        const deps = !a.service
          ? m.deps.filter((dd) => dd.member !== a.member)
          : m.deps.some((dd) => dd.member === a.member)
            ? m.deps.map((dd) => (dd.member === a.member ? { ...dd, service: a.service } : dd))
            : [...m.deps, { member: a.member, service: a.service }]
        return { ...m, deps }
      }
      return { ...asm, sites: asm.sites.map((s) => ({ ...s, models: mapInstanceAt(s.models, segs, set) })) }
    }
  }
}

// Instance path helpers: segments are the instance names below the simulator (containers/sites are transparent).
const pathSegs = (path: string, asmName: string) => path.slice(asmName.length + 1).split('.').filter(Boolean)

const mapInstanceAt = (models: ModelInstance[], segs: string[], fn: (m: ModelInstance) => ModelInstance): ModelInstance[] =>
  models.map((m) => {
    if (m.name !== segs[0]) return m
    if (segs.length === 1) return fn(m)
    return { ...m, containers: m.containers.map((c) => ({ ...c, children: mapInstanceAt(c.children, segs.slice(1), fn) })) }
  })

const removeInstanceAt = (models: ModelInstance[], segs: string[]): ModelInstance[] =>
  segs.length === 1
    ? models.filter((m) => m.name !== segs[0])
    : models.map((m) => (m.name === segs[0] ? { ...m, containers: m.containers.map((c) => ({ ...c, children: removeInstanceAt(c.children, segs.slice(1)) })) } : m))

const findInstanceAt = (models: ModelInstance[], segs: string[]): ModelInstance | null => {
  const m = models.find((x) => x.name === segs[0])
  if (!m) return null
  if (segs.length === 1) return m
  for (const c of m.containers) {
    const r = findInstanceAt(c.children, segs.slice(1))
    if (r) return r
  }
  return null
}

const randomName = () => {
  const alpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let s = ''
  for (let i = 0; i < 5; i++) s += alpha[Math.floor(Math.random() * alpha.length)]
  return s
}

const applyTopo = (assemblies: AssemblyModel[], a: TopoAction): AssemblyModel[] =>
  assemblies.map((x) => (x.path === a.asm ? applyTopoToAsm(x, a) : x))

// Design and topology edits share one journal (the snapshot's event list). Events are told apart by op.
const TOPO_OPS = new Set([
  'renameSimulator', 'addSite', 'removeSite', 'renameSite', 'setSiteMaxEvents',
  'addService', 'removeService', 'renameService', 'setServiceConfig',
  'addRootModel', 'addInstance', 'moveInstance', 'removeInstance', 'setInstanceConfig',
  'setReference', 'setServiceDep',
])
type JournalEvent = Entry | TopoAction
const isTopo = (e: JournalEvent): e is TopoAction => TOPO_OPS.has(e.op)

// ── Snapshots (baseline IR + edit journal, persisted under the project's .studio/snapshots/) ────────────────────────
// One snapshot = the implicit baseline (design IR + every assembly's topology) plus the pending edit journal, so a
// session survives a reload/restart. On load we re-derive the live IR and abort if its hash differs (drift) — this
// sprint the journal's name/path-targeted actions only replay safely onto the exact baseline they were captured against.
type SnapshotHeader = { id: string; label: string; savedUtc?: string; baselineCapturedUtc?: string }
type Snapshot = {
  schema: number
  id: string
  label: string
  baselineCapturedUtc: string
  savedUtc: string
  baseline: { hash: string; ir: { project: ProjectModel; assemblies: AssemblyModel[] } }
  journal: JournalEvent[]
}

const snapId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

// A structural, order-independent stringify: object keys are sorted AND array elements are sorted by their own
// canonical form. Roslyn returns a type's interfaces/members in an unstable order across opens, so an order-sensitive
// hash would flip on that noise and report false drift; a multiset hash is immune to it (reordering isn't real drift).
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(canonical).sort().join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
}
// FNV-1a 64-bit (two seeds) over the canonical form → hex. Used only for drift equality, not crypto.
const hashIr = (project: ProjectModel, assemblies: AssemblyModel[]): string => {
  const s = canonical({ project, assemblies })
  let h1 = 0x811c9dc5
  let h2 = 0xc2b2ae35
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca77)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
const fmtUtc = (s?: string) => {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

const uniqueName = (base: string, taken: Set<string>) => {
  let n = base
  for (let i = 2; taken.has(n); i++) n = base + i
  return n
}

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
// Both reference kinds — intra-site Reference and cross-site CrossReference — live on the right side.
const SIDE_OF: Record<string, Side> = {
  Inheritance: 'top',
  Reference: 'right',
  CrossReference: 'right',
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
  CrossReference: '#f59e0b',   // amber — a cross-site reference, visually distinct from the sky-blue intra Reference
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

// Body actions edit a type's members/associations; type actions reshape the set of types. A namespace
// gesture (delete a folder) expands, at the moment it's performed, into concrete atomic type actions
// frozen inside an ActionList — one undo unit that survives snapshot save/load and replays deterministically.
type Action =
  | { op: 'addMember'; typeKey: string; member: MemberRow }
  | { op: 'updateMember'; typeKey: string; name: string; member: MemberRow }
  | { op: 'removeMember'; typeKey: string; name: string }
  | { op: 'addAssociation'; typeKey: string; assoc: Association }
  | { op: 'renameAssociation'; typeKey: string; ref: Association; to: string }
  | { op: 'removeAssociation'; typeKey: string; ref: Association }
  | { op: 'addType'; typeKey: string; kind: string }
  | { op: 'renameType'; typeKey: string; to: string }
  | { op: 'removeType'; typeKey: string }
  | { op: 'renameNamespace'; typeKey: string; to: string } // typeKey = old namespace, to = new namespace
  | { op: 'moveType'; typeKey: string; to: string } // to = target namespace
type ActionList = { op: 'bundle'; label: string; actions: Action[] }
type Entry = Action | ActionList

const nsOf = (typeKey: string) => (typeKey.includes('.') ? typeKey.slice(0, typeKey.lastIndexOf('.')) : '')
const nameOf = (typeKey: string) => (typeKey.includes('.') ? typeKey.slice(typeKey.lastIndexOf('.') + 1) : typeKey)

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
    default:
      return t
  }
}

function applyAction(model: ProjectModel, a: Action): ProjectModel {
  switch (a.op) {
    case 'addType':
      return { ...model, types: [...model.types, { namespace: nsOf(a.typeKey), name: nameOf(a.typeKey), kind: a.kind, members: [], associations: [] }] }
    case 'removeType':
      return { ...model, types: model.types.filter((t) => key(t) !== a.typeKey) }
    case 'renameType': {
      const newKey = nsOf(a.typeKey) ? nsOf(a.typeKey) + '.' + a.to : a.to
      return {
        ...model,
        types: model.types.map((t) => {
          const renamed = key(t) === a.typeKey ? { ...t, name: a.to } : t
          // keep association edges pointing at the renamed type resolvable
          return { ...renamed, associations: renamed.associations.map((x) => (x.target === a.typeKey ? { ...x, target: newKey } : x)) }
        }),
      }
    }
    case 'moveType': {
      const newKey = a.to ? a.to + '.' + nameOf(a.typeKey) : nameOf(a.typeKey)
      return {
        ...model,
        types: model.types.map((t) => {
          const moved = key(t) === a.typeKey ? { ...t, namespace: a.to } : t
          return { ...moved, associations: moved.associations.map((x) => (x.target === a.typeKey ? { ...x, target: newKey } : x)) }
        }),
      }
    }
    case 'renameNamespace': {
      const oldNs = a.typeKey
      const newNs = a.to
      const rewriteNs = (ns: string) => (ns === oldNs ? newNs : ns.startsWith(oldNs + '.') ? newNs + ns.slice(oldNs.length) : ns)
      const rewriteKey = (k: string) => {
        const ns = rewriteNs(nsOf(k))
        return ns ? ns + '.' + nameOf(k) : nameOf(k)
      }
      return {
        ...model,
        types: model.types.map((t) => ({
          ...t,
          namespace: rewriteNs(t.namespace),
          associations: t.associations.map((x) => ({ ...x, target: rewriteKey(x.target) })),
        })),
      }
    }
    default:
      return { ...model, types: model.types.map((t) => (key(t) === a.typeKey ? applyToType(t, a) : t)) }
  }
}

function applyEntry(model: ProjectModel, entry: Entry): ProjectModel {
  return entry.op === 'bundle' ? entry.actions.reduce(applyAction, model) : applyAction(model, entry)
}

// Flatten a journal to the atomic action stream the backend applies (ActionLists spliced in order).
const flatten = (journal: Entry[]): Action[] => journal.flatMap((e) => (e.op === 'bundle' ? e.actions : [e]))

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

type TreeProps = {
  onSelect: (key: string) => void
  selectedKey: string | null
  onContext: (e: React.MouseEvent, kind: 'type' | 'ns', target: string) => void
  renamingKey: string | null
  onRenameType: (typeKey: string, to: string) => void
  onRenameCancel: () => void
  renamingNs: string | null
  onRenameNamespace: (oldNs: string, leaf: string) => void
  onRenameNsCancel: () => void
  onTreeDrop: (dragged: { kind: 'type' | 'ns'; id: string }, targetNs: string) => void
}

const DRAG_MIME = 'application/studio-tree'
const startDrag = (e: React.DragEvent, kind: 'type' | 'ns', id: string) => {
  e.stopPropagation()
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind, id }))
  e.dataTransfer.effectAllowed = 'move'
}

function NsFolder({ node, depth, ns, ...p }: { node: NsNode; depth: number; ns: string } & TreeProps) {
  const [open, setOpen] = useState(false)
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const types = [...node.types].sort(byKindThenName)
  const renaming = ns === p.renamingNs
  const [dropping, setDropping] = useState(false)
  return (
    <div>
      <div
        className={'row folder' + (dropping ? ' drop-target' : '')}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => !renaming && setOpen((o) => !o)}
        onContextMenu={(e) => p.onContext(e, 'ns', ns)}
        draggable={!renaming}
        onDragStart={(e) => startDrag(e, 'ns', ns)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_MIME)) {
            e.preventDefault()
            setDropping(true)
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDropping(false)
          const raw = e.dataTransfer.getData(DRAG_MIME)
          if (raw) p.onTreeDrop(JSON.parse(raw), ns)
        }}
      >
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="folder-badge">N</span>
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={node.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={p.onRenameNsCancel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.onRenameNamespace(ns, (e.target as HTMLInputElement).value)
              else if (e.key === 'Escape') p.onRenameNsCancel()
            }}
          />
        ) : (
          <span className="row-label">{node.name}</span>
        )}
      </div>
      {open && (
        <>
          {folders.map((c) => (
            <NsFolder key={c.name} node={c} depth={depth + 1} ns={ns + '.' + c.name} {...p} />
          ))}
          {types.map((t) => (
            <TypeRow key={t.name} t={t} depth={depth + 1} {...p} />
          ))}
        </>
      )}
    </div>
  )
}

function TypeRow({ t, depth, onSelect, selectedKey, onContext, renamingKey, onRenameType, onRenameCancel }: { t: DesignableType; depth: number } & TreeProps) {
  const k = key(t)
  const selected = k === selectedKey
  const renaming = k === renamingKey
  return (
    <div
      className={'row type' + (selected ? ' selected' : '')}
      style={{ paddingLeft: depth * 14 + 24 }}
      onClick={() => !renaming && onSelect(k)}
      onContextMenu={(e) => onContext(e, 'type', k)}
      draggable={!renaming}
      onDragStart={(e) => startDrag(e, 'type', k)}
    >
      <span className={'badge k-' + t.kind} title={t.kind}>
        {shortKind(t.kind)}
      </span>
      {renaming ? (
        <input
          className="rename-input"
          autoFocus
          defaultValue={t.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={onRenameCancel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameType(k, (e.target as HTMLInputElement).value)
            else if (e.key === 'Escape') onRenameCancel()
          }}
        />
      ) : (
        <span className="row-label">{t.name}</span>
      )}
    </div>
  )
}

// ── Tree context menu + New Type dialog ───────────────────────────────────────────

function NewTypeDialog({ stable, onCreate, onCancel }: { stable: string; onCreate: (typeKey: string, kind: string) => void; onCancel: () => void }) {
  const [declared, setDeclared] = useState('')
  const [kind, setKind] = useState('Model')
  const d = declared.trim()
  const valid = d.length > 0 && !d.startsWith('.') && !d.endsWith('.')
  const fullKey = stable ? stable + '.' + d : d
  const create = () => valid && onCreate(fullKey, kind)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">New type</div>
        <div className="nt-key">
          {stable && <span className="nt-stable">{stable}.</span>}
          <input
            className="nt-declared"
            autoFocus
            placeholder="Name  (or Sub.Name to nest)"
            value={declared}
            onChange={(e) => setDeclared(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="Model">Model</option>
          <option value="Service">Service</option>
          <option value="Interface">Interface</option>
          <option value="Other">Other (plain class)</option>
        </select>
        <div className="modal-actions">
          <button className="mf-save" disabled={!valid} onClick={create}>
            Create
          </button>
          <button className="mf-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
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
  const [params, setParams] = useState(initial?.params ?? '')
  const [facets, setFacets] = useState<string[]>(initial?.facets ?? [])

  const catalog = FACETS_BY_KIND[kind] ?? []
  const single = kind === 'Interface' // a member is a Property XOR a Method
  const addable = catalog.filter((f) => !facets.includes(f))
  const isMethod = facets.includes('Method') || facets.includes('ServiceRequest') // takes a signature, not just a type
  const valid = name.trim().length > 0 && facets.length > 0

  const commit = () =>
    valid &&
    onSave({
      name: name.trim(),
      type: type.trim() || null,
      facets,
      params: isMethod ? params.trim() || null : null,
    })

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
          placeholder={isMethod ? 'returns' : 'type'}
          value={type}
          onChange={(e) => setType(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </div>
      {isMethod && (
        <input
          className="mf-params"
          placeholder="parameters, e.g. int slot, double watts"
          value={params}
          onChange={(e) => setParams(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      )}
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

function DeleteNamespaceDialog({ ns, count, onDeleteAll, onMoveUp, onCancel }: { ns: string; count: number; onDeleteAll: () => void; onMoveUp: () => void; onCancel: () => void }) {
  const parent = ns.includes('.') ? ns.slice(0, ns.lastIndexOf('.')) : '(root)'
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Delete namespace {ns}</div>
        <div className="modal-body">
          It holds {count} type{count !== 1 ? 's' : ''}. Move them up to <strong>{parent}</strong>, or delete them?
        </div>
        <div className="modal-actions">
          <button className="mf-cancel" onClick={onCancel}>Cancel</button>
          <button className="mf-save" onClick={onMoveUp}>Move up</button>
          <button className="danger-btn" onClick={onDeleteAll}>Delete all</button>
        </div>
      </div>
    </div>
  )
}

function MoveTypeDialog({ typeKey, onMove, onCancel }: { typeKey: string; onMove: (typeKey: string, ns: string) => void; onCancel: () => void }) {
  const [ns, setNs] = useState(typeKey.includes('.') ? typeKey.slice(0, typeKey.lastIndexOf('.')) : '')
  const name = typeKey.includes('.') ? typeKey.slice(typeKey.lastIndexOf('.') + 1) : typeKey
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Move {name}</div>
        <div className="nt-key">
          <input className="nt-declared" autoFocus placeholder="target namespace" value={ns} onChange={(e) => setNs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onMove(typeKey, ns)} />
          <span className="nt-stable">.{name}</span>
        </div>
        <div className="modal-actions">
          <button className="mf-cancel" onClick={onCancel}>Cancel</button>
          <button className="mf-save" onClick={() => onMove(typeKey, ns)}>Move</button>
        </div>
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
  kinds: string[] // the kind(s) this side may create; >1 (right side: Reference/CrossReference) renders a toggle
  allTypes: DesignableType[] // candidate pool — filtered per chosen kind via candidatesFor
  selKey: string // the selected type's key, excluded from candidates
  onAdd: (assoc: Association) => void
}

function AddStubNode({ data }: NodeProps) {
  const d = data as unknown as AddStubData
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState(d.kinds[0])
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const named = kind !== 'Inheritance'
  const candidates = candidatesFor(kind, d.allTypes, d.selKey)
  const valid = target !== '' && (!named || name.trim().length > 0)
  // Switching kind can invalidate the picked target (e.g. Reference→CrossReference narrows to interfaces).
  const pickKind = (k: string) => {
    setKind(k)
    if (target && !candidatesFor(k, d.allTypes, d.selKey).some((c) => key(c) === target)) setTarget('')
  }

  if (!open)
    return (
      <div className="add-stub">
        <NodeHandles />
        <button className="add-stub-btn" title={'add ' + d.kinds.join('/')} onClick={() => setOpen(true)}>
          +
        </button>
      </div>
    )

  return (
    <div className="add-stub open">
      <NodeHandles />
      <div className="stub-form" onClick={(e) => e.stopPropagation()}>
        {d.kinds.length > 1 ? (
          <div className="stub-kind-toggle">
            {d.kinds.map((k) => (
              <button
                key={k}
                className={'stub-kind-opt' + (k === kind ? ' sel' : '')}
                style={k === kind ? { color: EDGE_COLOR[k], borderColor: EDGE_COLOR[k] } : undefined}
                onClick={() => pickKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
        ) : (
          <div className="stub-kind" style={{ color: EDGE_COLOR[kind] }}>
            {kind}
          </div>
        )}
        <select className="stub-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">target…</option>
          {candidates.map((c) => (
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
            onClick={() => valid && d.onAdd({ kind, name: named ? name.trim() : '', target })}
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
                {(m.facets.includes('Method') || m.facets.includes('ServiceRequest')) && `(${m.params ?? ''})`}
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

/// Valid target types for a new association of the given kind, excluding the type itself:
///   ServiceDep → services/interfaces; CrossReference → interfaces only (a cross-site reference must target an
///   interface); anything else (Reference/Containment/Inheritance) → any other type.
function candidatesFor(kind: string, allTypes: DesignableType[], selKey: string) {
  const pool = allTypes.filter((t) => key(t) !== selKey)
  if (kind === 'ServiceDep')
    return pool.filter((t) => t.kind === 'Service' || t.kind === 'LooselyCoupledService' || t.kind === 'Interface')
  if (kind === 'CrossReference') return pool.filter((t) => t.kind === 'Interface')
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
    nodes.push({
      id: 'stub:' + side,
      type: 'addStub',
      position: placeSide(side, bySide[side].length, count),
      data: { side, kinds: KINDS_OF_SIDE[side], allTypes: h.allTypes, selKey, onAdd: h.onAddAssoc } as unknown as Record<string, unknown>,
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

// Which association kind(s) each side creates. The right side offers a choice — an intra-site Reference or a
// cross-site CrossReference — so its add-stub renders a toggle; the other sides have a single kind.
const KINDS_OF_SIDE: Record<Side, string[]> = { top: ['Inheritance'], right: ['Reference', 'CrossReference'], left: ['ServiceDep'], bottom: ['Containment'] }

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

// ── Topology view (top level: services | sites) + site drill-in ─────────────────

type SiteCtx = {
  asmPath: string
  paramsOf: (t: string) => string[]
  containersOf: (t: string) => { name: string; elementType: string }[]
  candidatesOf: (t: string) => { fqn: string; label: string }[]
  allModels: { fqn: string; label: string }[]
  onAddRootModel: (asm: string, site: string, name: string, type: string) => void
  onAddInstance: (asm: string, parentPath: string, container: string, name: string, type: string) => void
  onMoveInstance: (asm: string, path: string, toParentPath: string, toContainer: string) => void
  onRemoveInstance: (asm: string, path: string) => void
  onSetInstanceConfig: (asm: string, path: string, key: string, value: string) => void
}

type MoveTarget = { toParentPath: string; toContainer: string; label: string }

// Every container across the site forest into which the focused instance may be moved: element type accepts the
// instance's type, the container is neither its current home nor inside its own subtree (which would orphan it).
function moveTargetsFor(asmName: string, site: SiteInstance, focusPath: string, focusType: string, ctx: SiteCtx): MoveTarget[] {
  const out: MoveTarget[] = []
  const focusName = focusPath.slice(focusPath.lastIndexOf('.') + 1)
  const walk = (inst: ModelInstance, path: string) => {
    const inFocusSubtree = path === focusPath || path.startsWith(focusPath + '.')
    if (!inFocusSubtree)
      for (const tc of ctx.containersOf(inst.type)) {
        if (!ctx.candidatesOf(tc.elementType).some((c) => c.fqn === focusType)) continue
        const holdsFocus = path + '.' + focusName === focusPath && !!inst.containers.find((c) => c.name === tc.name)?.children.some((ch) => ch.name === focusName)
        if (holdsFocus) continue // already here
        out.push({ toParentPath: path, toContainer: tc.name, label: `${path.slice(asmName.length + 1)} ▸ ${tc.name}` })
      }
    for (const c of inst.containers) for (const ch of c.children) walk(ch, path + '.' + ch.name)
  }
  for (const m of site.models) walk(m, asmName + '.' + m.name)
  return out
}

// A model instance in the site canvas. Unfocused it is compact; focused ("Model view") it enlarges and shows its
// editable Config. Removable instances (a root, or a focused node's child) carry a round delete.
function TopoInstanceNode({ data }: NodeProps) {
  const d = data as { inst: ModelInstance; focused: boolean; path: string; params: string[]; removable: boolean; moveTargets: MoveTarget[]; ctx: SiteCtx }
  const inst = d.inst
  return (
    <div className={'topo-fnode inst' + (d.focused ? ' focused' : '')}>
      <Handle id="t" type="target" position={Position.Top} className="nh" isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} className="nh" isConnectable={false} />
      {d.removable && (
        <button className="topo-del round" title="delete instance" onClick={(e) => { e.stopPropagation(); d.ctx.onRemoveInstance(d.ctx.asmPath, d.path) }}>
          ×
        </button>
      )}
      <div className="topo-fnode-head">{inst.name}</div>
      <div className="topo-fnode-type">{inst.type}</div>
      {d.focused && d.params.length > 0 && (
        <div className="topo-params" onClick={(e) => e.stopPropagation()}>
          {d.params.map((k) => (
            <div key={k} className="topo-param">
              <span className="topo-param-k">{k}</span>
              <EditableText className="topo-param-v" value={inst.config[k] ?? ''} placeholder="default" onCommit={(v) => d.ctx.onSetInstanceConfig(d.ctx.asmPath, d.path, k, v)} />
            </div>
          ))}
        </div>
      )}
      {d.focused && d.moveTargets.length > 0 && (
        <div className="topo-move" onClick={(e) => e.stopPropagation()}>
          <select
            className="topo-move-select"
            value=""
            title="move this instance into another container"
            onChange={(e) => {
              const t = d.moveTargets[Number(e.target.value)]
              if (t) d.ctx.onMoveInstance(d.ctx.asmPath, d.path, t.toParentPath, t.toContainer)
            }}
          >
            <option value="">move to…</option>
            {d.moveTargets.map((t, i) => (
              <option key={t.label} value={i}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

// A container junction (React Flow edges are point-to-point, so a container fans via this node). Its "+" opens an
// add-instance form: a name and a type (dropdown of models assignable to the container's [Contains<T>] element type).
function TopoContainerNode({ data }: NodeProps) {
  const d = data as { name: string; parentPath: string; candidates: { fqn: string; label: string }[]; ctx: SiteCtx }
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const valid = name.trim().length > 0 && type.length > 0
  const create = () => {
    if (!valid) return
    d.ctx.onAddInstance(d.ctx.asmPath, d.parentPath, d.name, name.trim(), type)
    setAdding(false)
    setName('')
  }
  return (
    <div className={'topo-container-node' + (adding ? ' adding' : '')} onClick={(e) => e.stopPropagation()}>
      <Handle id="t" type="target" position={Position.Top} className="nh" isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} className="nh" isConnectable={false} />
      {adding ? (
        <div className="topo-add-inst">
          <div className="topo-container-name">{d.name}</div>
          <input autoFocus placeholder="name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">type…</option>
            {d.candidates.map((c) => (
              <option key={c.fqn} value={c.fqn}>
                {c.label}
              </option>
            ))}
          </select>
          <div className="topo-add-inst-actions">
            <button className="mf-save" disabled={!valid} onClick={create}>add</button>
            <button className="mf-cancel" onClick={() => setAdding(false)}>cancel</button>
          </div>
        </div>
      ) : (
        <>
          <span>{d.name}</span>
          <button className="topo-container-add" title="add instance" onClick={() => { setType(d.candidates.length === 1 ? d.candidates[0].fqn : ''); setAdding(true) }}>
            +
          </button>
        </>
      )}
    </div>
  )
}

const topoNodeTypes = { inst: TopoInstanceNode, container: TopoContainerNode }

const gEdge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  sourceHandle: 'b',
  targetHandle: 't',
  style: { stroke: EDGE_COLOR.Containment, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR.Containment },
})

// The site canvas: a containment tree. Children are merged (flat) until their parent is the focused node, when its
// type's containers each become a junction node (even empty ones — you fill them) that fans to its children.
function buildSiteGraph(asm: AssemblyModel, site: SiteInstance, focus: string | null, ctx: SiteCtx): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const X = 220
  const Y = 150
  let leaf = 0

  const walk = (inst: ModelInstance, parentPath: string, depth: number, removable: boolean): { id: string; x: number } => {
    const path = parentPath + '.' + inst.name
    const id = 'i:' + path
    const focused = path === focus
    const childXs: number[] = []

    if (focused) {
      // type-dictated containers (even empty), populated with the assembly's children
      ctx.containersOf(inst.type).forEach((tc, ci) => {
        const children = inst.containers.find((c) => c.name === tc.name)?.children ?? []
        const results = children.map((ch) => walk(ch, path, depth + 1, true))
        results.forEach((r) => childXs.push(r.x))
        const cx = results.length ? results.reduce((s, r) => s + r.x, 0) / results.length : leaf++ * X
        const ctId = `ct:${path}:${ci}`
        nodes.push({
          id: ctId,
          type: 'container',
          position: { x: cx, y: depth * Y + Y * 0.5 },
          data: { name: tc.name, parentPath: path, candidates: ctx.candidatesOf(tc.elementType), ctx } as unknown as Record<string, unknown>,
        })
        edges.push(gEdge(`e:${id}>${ctId}`, id, ctId))
        results.forEach((r) => edges.push(gEdge(`e:${ctId}>${r.id}`, ctId, r.id)))
      })
    } else {
      for (const c of inst.containers)
        for (const ch of c.children) {
          const r = walk(ch, path, depth + 1, false)
          edges.push(gEdge(`e:${id}>${r.id}`, id, r.id))
          childXs.push(r.x)
        }
    }

    const x = childXs.length ? (Math.min(...childXs) + Math.max(...childXs)) / 2 : leaf++ * X
    nodes.push({
      id,
      type: 'inst',
      position: { x, y: depth * Y },
      data: {
        inst,
        focused,
        path,
        params: ctx.paramsOf(inst.type),
        removable,
        moveTargets: focused ? moveTargetsFor(asm.name, site, path, inst.type, ctx) : [],
        ctx,
      } as unknown as Record<string, unknown>,
    })
    return { id, x }
  }

  for (const m of site.models) walk(m, asm.name, 0, true) // roots are removable
  return { nodes, edges }
}

// Add a root model directly to a SimSite (a site's top-level instances have no container — any project model may be a
// root). A "+ model" toggle in the site head opens a name field and a type dropdown of every model type.
function AddRootModel({ ctx, site }: { ctx: SiteCtx; site: string }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const valid = name.trim().length > 0 && type.length > 0
  const create = () => {
    if (!valid) return
    ctx.onAddRootModel(ctx.asmPath, site, name.trim(), type)
    setAdding(false)
    setName('')
    setType('')
  }
  if (!adding)
    return (
      <button
        className="topo-add-root"
        title="add a root model to this site"
        onClick={() => {
          setType(ctx.allModels.length === 1 ? ctx.allModels[0].fqn : '')
          setAdding(true)
        }}
      >
        + model
      </button>
    )
  return (
    <span className="topo-add-root-form">
      <input autoFocus placeholder="name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">type…</option>
        {ctx.allModels.map((c) => (
          <option key={c.fqn} value={c.fqn}>
            {c.label}
          </option>
        ))}
      </select>
      <button className="mf-save" disabled={!valid} onClick={create}>add</button>
      <button className="mf-cancel" onClick={() => setAdding(false)}>cancel</button>
    </span>
  )
}

function SiteView({ asm, site, ctx, rev, onBack }: { asm: AssemblyModel; site: SiteInstance; ctx: SiteCtx; rev: number; onBack: () => void }) {
  const [focus, setFocus] = useState<string | null>(null)
  const { nodes, edges } = buildSiteGraph(asm, site, focus, ctx)

  // ESC ascends one level (child → parent → site); clicking a node descends onto it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setFocus((f) => {
        if (!f) return null
        const parent = f.slice(0, f.lastIndexOf('.'))
        return parent === asm.name || !parent.includes('.') ? null : parent
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asm.name])

  return (
    <div className="topo-site">
      <div className="topo-site-head">
        <button className="topo-back" onClick={onBack}>
          ← Sites
        </button>
        <span className="topo-site-name">{site.name}</span>
        <span className="topo-dim">
          · max {site.maxEvents} events{focus ? ` · ${focus.slice(asm.name.length + 1)}` : ''}
        </span>
        {!focus && <AddRootModel ctx={ctx} site={site.name} />}
      </div>
      <div className="topo-canvas">
        <ReactFlow
          key={'site:' + (focus ?? '') + ':' + rev}
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={topoNodeTypes}
          onNodeClick={(_, node) => node.type === 'inst' && setFocus(node.id.slice(2))}
          fitView
          fitViewOptions={{ minZoom: 0.3, maxZoom: 1.3 }}
          colorMode="dark"
          nodesConnectable={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}

// ── References view (edit-references button): wire [Reference<T>] / [CrossReference<T>] / [ServiceRef] across the whole assembly ──

// A wirable reference field. `isCross` is the field's design kind — false for an intra-site [Reference<T>], true for a
// cross-site [CrossReference<T>] — so wiring can file the binding under the right YAML block.
type RefField = { name: string; target: string; isCross: boolean }
// The data helpers the references view needs (supplied by the app); RefsView adds the view-local onWire below.
type RefsData = {
  refFieldsOf: (type: string) => RefField[]
  serviceRefsOf: (type: string) => { member: string; target: string }[]
  assignable: (type: string, T: string) => boolean // is an instance/service of `type` assignable to reference target `T`
  services: { name: string; type: string }[] // the assembly's service instances (for the [ServiceRef] dropdown)
  onSetReference: (asm: string, path: string, name: string, targets: string[], isCross: boolean) => void
  onSetServiceDep: (asm: string, path: string, member: string, service: string) => void
}
type RefsCtx = RefsData & { asmPath: string; onWire: (path: string, name: string, target: string, isCross: boolean) => void }

const shortName = (fqn: string) => (fqn.includes('.') ? fqn.slice(fqn.lastIndexOf('.') + 1) : fqn)

// A node in the references forest. Enlarged (and not wiring) it lists its type's reference fields (both [Reference<T>]
// and [CrossReference<T>]) (click → wiring)
// and [ServiceRef] fields (a service dropdown). While wiring, every node is tinted lit/wirable/disabled instead.
function RefNode({ data }: NodeProps) {
  const d = data as {
    inst: ModelInstance
    path: string
    enlarged: boolean
    wire: null | { isSelf: boolean; lit: boolean; compatible: boolean; disabled: boolean }
    ctx: RefsCtx
  }
  const { inst, ctx } = d
  const refFields = ctx.refFieldsOf(inst.type)
  const svcFields = ctx.serviceRefsOf(inst.type)
  const hasFields = refFields.length > 0 || svcFields.length > 0
  const cls =
    'topo-fnode inst refnode' +
    (d.enlarged ? ' focused' : '') +
    (d.wire ? (d.wire.lit ? ' lit' : d.wire.disabled ? ' disabled' : ' wirable') : hasFields ? ' has-refs' : '')
  return (
    <div className={cls}>
      <Handle id="t" type="target" position={Position.Top} className="nh" isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} className="nh" isConnectable={false} />
      <div className="topo-fnode-head">{inst.name}</div>
      <div className="topo-fnode-type">{inst.type}</div>
      {d.enlarged && !d.wire && (
        <div className="ref-fields" onClick={(e) => e.stopPropagation()}>
          {refFields.map((f) => {
            const n = inst.refs.find((r) => r.name === f.name)?.targets.length ?? 0
            return (
              <button
                key={'ref:' + f.name}
                className={'ref-field' + (f.isCross ? ' cross' : '')}
                title={f.isCross ? 'cross-site [CrossReference]' : 'intra-site [Reference]'}
                onClick={() => ctx.onWire(d.path, f.name, f.target, f.isCross)}
              >
                <span className="ref-field-name">{f.name}</span>
                <span className="ref-field-t">→ {shortName(f.target)}{n ? ` · ${n}` : ''}</span>
              </button>
            )
          })}
          {svcFields.map((f) => {
            const cur = inst.deps.find((dd) => dd.member === f.member)?.service ?? ''
            const opts = ctx.services.filter((s) => ctx.assignable(s.type, f.target))
            return (
              <div key={'dep:' + f.member} className="ref-dep">
                <span className="ref-field-name">{f.member}</span>
                <select value={cur} onChange={(e) => ctx.onSetServiceDep(ctx.asmPath, d.path, f.member, e.target.value)}>
                  <option value="">— none —</option>
                  {opts.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
          {refFields.length === 0 && svcFields.length === 0 && <div className="ref-none">no references or service deps on this type</div>}
        </div>
      )}
    </div>
  )
}

const refsNodeTypes = { refnode: RefNode }

// The combined instance forest of every site in the assembly, merged (containers flat). Node data carries each node's
// wiring tint (lit / self / incompatible) when a reference field is being wired.
function buildRefsGraph(
  asm: AssemblyModel,
  enlarged: string | null,
  wiring: { path: string; name: string; target: string; isCross: boolean } | null,
  wiringTargets: string[],
  ctx: RefsCtx,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const X = 200
  const Y = 150
  let leaf = 0
  const walk = (inst: ModelInstance, parentPath: string, depth: number): { id: string; x: number } => {
    const path = parentPath + '.' + inst.name
    const id = 'r:' + path
    const childXs: number[] = []
    for (const c of inst.containers)
      for (const ch of c.children) {
        const r = walk(ch, path, depth + 1)
        edges.push(gEdge(`e:${id}>${r.id}`, id, r.id))
        childXs.push(r.x)
      }
    const x = childXs.length ? (Math.min(...childXs) + Math.max(...childXs)) / 2 : leaf++ * X
    let wire = null
    if (wiring) {
      const isSelf = path === wiring.path
      const lit = wiringTargets.includes(path)
      const compatible = ctx.assignable(inst.type, wiring.target)
      wire = { isSelf, lit, compatible, disabled: isSelf || (!compatible && !lit) }
    }
    nodes.push({ id, type: 'refnode', position: { x, y: depth * Y }, data: { inst, path, enlarged: path === enlarged, wire, ctx } as unknown as Record<string, unknown> })
    return { id, x }
  }
  for (const s of asm.sites) for (const m of s.models) walk(m, asm.name, 0)
  return { nodes, edges }
}

function RefsView({ asm, data, rev, onBack }: { asm: AssemblyModel; data: RefsData; rev: number; onBack: () => void }) {
  const [enlarged, setEnlarged] = useState<string | null>(null)
  const [wiring, setWiring] = useState<{ path: string; name: string; target: string; isCross: boolean } | null>(null)

  const findByPath = (path: string): ModelInstance | null => {
    const segs = pathSegs(path, asm.name)
    for (const s of asm.sites) {
      const inst = findInstanceAt(s.models, segs)
      if (inst) return inst
    }
    return null
  }
  const wiringTargets = wiring ? findByPath(wiring.path)?.refs.find((r) => r.name === wiring.name)?.targets ?? [] : []

  // ESC steps out: wiring → enlarged → the sites view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (wiring) setWiring(null)
      else if (enlarged) setEnlarged(null)
      else onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wiring, enlarged, onBack])

  const ctx: RefsCtx = { ...data, asmPath: asm.path, onWire: (path, name, target, isCross) => setWiring({ path, name, target, isCross }) }
  const { nodes, edges } = buildRefsGraph(asm, enlarged, wiring, wiringTargets, ctx)

  const setTargets = (targets: string[]) => wiring && data.onSetReference(asm.path, wiring.path, wiring.name, targets, wiring.isCross)
  const reorder = (i: number, dir: -1 | 1) => {
    const arr = [...wiringTargets]
    ;[arr[i], arr[i + dir]] = [arr[i + dir], arr[i]]
    setTargets(arr)
  }
  const onNodeClick = (path: string) => {
    if (!wiring) {
      setEnlarged((e) => (e === path ? null : path))
      return
    }
    if (wiringTargets.includes(path)) setTargets(wiringTargets.filter((t) => t !== path))
    else if (path !== wiring.path && data.assignable(findByPath(path)?.type ?? '', wiring.target)) setTargets([...wiringTargets, path])
  }

  return (
    <div className="topo-site">
      <div className="topo-site-head">
        <button className="topo-back" onClick={onBack}>
          ← Sites
        </button>
        <span className="topo-site-name">References</span>
        <span className="topo-dim">
          · {asm.name}
          {enlarged && !wiring ? ` · ${enlarged.slice(asm.name.length + 1)}` : ''}
          {wiring ? ` · wiring ${wiring.name}` : ''}
        </span>
      </div>
      <div className="topo-canvas ref-canvas">
        {nodes.length === 0 ? (
          <div className="topo-empty">No instances to wire — add root models in the site views first.</div>
        ) : (
          <ReactFlow
            key={'refs:' + (enlarged ?? '') + ':' + (wiring ? wiring.path + '/' + wiring.name : '') + ':' + rev}
            defaultNodes={nodes}
            defaultEdges={edges}
            nodeTypes={refsNodeTypes}
            onNodeClick={(_, node) => onNodeClick(node.id.slice(2))}
            fitView
            fitViewOptions={{ minZoom: 0.3, maxZoom: 1.3 }}
            colorMode="dark"
            nodesConnectable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        {wiring && (
          <div className="ref-wire-panel" onClick={(e) => e.stopPropagation()}>
            <div className="ref-wire-head">
              {wiring.name} <span className="ref-wire-t">→ {shortName(wiring.target)}</span>
            </div>
            <div className="ref-wire-hint">click a lit node to remove, an outlined node to add · ESC to finish</div>
            <ol className="ref-wire-list">
              {wiringTargets.map((t, i) => (
                <li key={t}>
                  <span className="ref-wire-idx">[{i}]</span>
                  <span className="ref-wire-path">{t.slice(asm.name.length + 1)}</span>
                  <button className="ref-wire-btn" disabled={i === 0} title="move up" onClick={() => reorder(i, -1)}>
                    ▲
                  </button>
                  <button className="ref-wire-btn" disabled={i === wiringTargets.length - 1} title="move down" onClick={() => reorder(i, 1)}>
                    ▼
                  </button>
                  <button className="ref-wire-btn del" title="remove" onClick={() => setTargets(wiringTargets.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </li>
              ))}
              {wiringTargets.length === 0 && <li className="ref-wire-empty">no targets — click compatible nodes</li>}
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}

// Inline click-to-edit text. Enter commits; Esc and clicking away cancel (no commit). Stops propagation so a click
// doesn't also trigger the card behind it.
function EditableText({ value, onCommit, className, placeholder }: { value: string; onCommit: (v: string) => void; className: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  if (!editing)
    return (
      <span
        className={className}
        title="click to edit"
        onClick={(e) => {
          e.stopPropagation()
          setText(value)
          setEditing(true)
        }}
      >
        {value || <span className="placeholder">{placeholder}</span>}
      </span>
    )
  return (
    <input
      className={className + ' inline-edit'}
      autoFocus
      value={text}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => setEditing(false)} // clicking away cancels
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setEditing(false)
          if (text.trim() && text.trim() !== value) onCommit(text.trim())
        } else if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

type TopoHandlers = {
  onOpenSite: (asmPath: string, siteName: string) => void
  onOpenRefs: (asmPath: string) => void
  onRenameSimulator: (asm: string, to: string) => void
  onAddSite: (asm: string) => void
  onRemoveSite: (asm: string, name: string) => void
  onRenameSite: (asm: string, from: string, to: string) => void
  onSetSiteMaxEvents: (asm: string, name: string, value: string) => void
  onAddService: (asm: string, type: string) => void
  onRemoveService: (asm: string, name: string) => void
  onRenameService: (asm: string, from: string, to: string) => void
  onSetServiceConfig: (asm: string, name: string, key: string, value: string) => void
}

// A service card: name heading + (read-only) type subtitle + round delete. Click the box to edit — the name becomes
// an input and its Config parameters appear; clicking away (focus leaves the card) commits and collapses.
function ServiceCard({ asm, s, params, h }: { asm: string; s: ServiceInstance; params: string[]; h: TopoHandlers }) {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState(s.name)
  return (
    <>
      {/* while editing, a backdrop cancels on click and swallows it (so it doesn't enter another card) */}
      {expanded && <div className="topo-backdrop" onClick={() => setExpanded(false)} />}
      <div
        className={'topo-card service' + (expanded ? ' expanded' : '')}
        onClick={() => {
          if (!expanded) {
            setName(s.name)
            setExpanded(true)
          }
        }}
      >
        <button className="topo-del round" title="delete service" onClick={(e) => { e.stopPropagation(); h.onRemoveService(asm, s.name) }}>
          ×
        </button>
        {expanded ? (
          <input
            className="topo-name-input"
            autoFocus
            value={name}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = name.trim()
                if (n && n !== s.name) h.onRenameService(asm, s.name, n)
                setExpanded(false)
              } else if (e.key === 'Escape') setExpanded(false)
            }}
          />
        ) : (
          <div className="topo-card-name">{s.name || '_'}</div>
        )}
        <div className="topo-card-type">{s.type || '_'}</div>
        {expanded && (
          <div className="topo-params" onClick={(e) => e.stopPropagation()}>
            {params.length === 0 && <div className="topo-params-empty">no parameters on this type</div>}
            {params.map((k) => (
              <div key={k} className="topo-param">
                <span className="topo-param-k">{k}</span>
                <EditableText className="topo-param-v" value={s.config[k] ?? ''} placeholder="default" onCommit={(val) => h.onSetServiceConfig(asm, s.name, k, val)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// A site card: name heading + editable max-events subtitle + round delete. Clicking the card (outside the editable
// name/max-events) opens the SimSite view — unless the click was cancelling an inline edit, in which case it's swallowed.
function SiteCard({ asm, site, h }: { asm: string; site: SiteInstance; h: TopoHandlers }) {
  const ref = useRef<HTMLDivElement>(null)
  const cancelling = useRef(false)
  return (
    <div
      ref={ref}
      className="topo-card site"
      title="open site"
      onMouseDown={() => {
        cancelling.current = !!ref.current?.querySelector('.inline-edit') // a field is being edited → this click cancels
      }}
      onClick={() => {
        if (cancelling.current) {
          cancelling.current = false
          return
        }
        h.onOpenSite(asm, site.name)
      }}
    >
      <button className="topo-del round" title="delete site" onClick={(e) => { e.stopPropagation(); h.onRemoveSite(asm, site.name) }}>
        ×
      </button>
      <EditableText className="topo-card-name" value={site.name} placeholder="_" onCommit={(to) => h.onRenameSite(asm, site.name, to)} />
      <div className="topo-card-sub">
        max <EditableText className="topo-sub-num" value={String(site.maxEvents)} onCommit={(v) => h.onSetSiteMaxEvents(asm, site.name, v)} /> events
      </div>
    </div>
  )
}

// "+ service" is a dropdown of the project's service types (a service needs a type at creation).
function AddServiceRow({ types, onAdd }: { types: { fqn: string; label: string }[]; onAdd: (type: string) => void }) {
  return (
    <select
      className="topo-add topo-add-select"
      value=""
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value)
      }}
    >
      <option value="">+ service…</option>
      {types.map((t) => (
        <option key={t.fqn} value={t.fqn}>
          {t.label}
        </option>
      ))}
    </select>
  )
}

function TopologyView({
  assemblies,
  paramsOf,
  serviceTypes,
  h,
}: {
  assemblies: AssemblyModel[] | null
  paramsOf: (fqType: string) => string[]
  serviceTypes: { fqn: string; label: string }[]
  h: TopoHandlers
}) {
  if (assemblies === null) return <div className="topo-empty">Loading topology…</div>
  if (!assemblies.length) return <div className="topo-empty">No assemblies (*.simassembly.yaml) registered in this project.</div>
  return (
    <div className="topo">
      {assemblies.map((a) => (
        <div key={a.path} className="topo-asm">
          <div className="topo-asm-head">
            <EditableText className="topo-sim" value={a.name} placeholder="_" onCommit={(to) => h.onRenameSimulator(a.path, to)} />
            <span className="topo-path">{a.path.split(/[\\/]/).pop()}</span>
            <button className="topo-refs-btn" title="wire references & service deps across the whole simulator" onClick={() => h.onOpenRefs(a.path)}>
              ⇄ references
            </button>
          </div>
          <div className="topo-cols">
            <section className="topo-col">
              <div className="topo-col-title">Services · {a.services.length}</div>
              {a.services.map((s) => (
                <ServiceCard key={s.name} asm={a.path} s={s} params={paramsOf(s.type)} h={h} />
              ))}
              <AddServiceRow types={serviceTypes} onAdd={(type) => h.onAddService(a.path, type)} />
            </section>

            <section className="topo-col">
              <div className="topo-col-title">Sites · {a.sites.length}</div>
              {a.sites.map((site) => (
                <SiteCard key={site.name} asm={a.path} site={site} h={h} />
              ))}
              <button className="topo-add" onClick={() => h.onAddSite(a.path)}>
                + site
              </button>
            </section>
          </div>
        </div>
      ))}
    </div>
  )
}

// Topbar snapshot controls: a chip for the snapshot being worked from (if any) + a Save button that opens a label field.
function SnapshotControls({ current, onSave }: { current: { id: string; label: string } | null; onSave: (label: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState('')
  const commit = () => {
    const l = label.trim()
    if (!l) return
    onSave(l)
    setEditing(false)
  }
  if (editing)
    return (
      <span className="snap-save">
        <input
          autoFocus
          placeholder="snapshot label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
        <button onClick={commit} disabled={!label.trim()}>
          Save
        </button>
        <button className="snap-x" onClick={() => setEditing(false)}>
          ✕
        </button>
      </span>
    )
  return (
    <span className="snap-ctl">
      {current && <span className="snap-chip" title="working from this snapshot; Generate re-saves it">◆ {current.label}</span>}
      <button
        onClick={() => {
          setLabel(current?.label ?? '')
          setEditing(true)
        }}
        title="Save a snapshot (baseline + pending journal)"
      >
        Save Snapshot
      </button>
    </span>
  )
}

// The on-open prompt when a project already has saved snapshots: continue one, or start fresh.
function SnapshotPrompt({ snapshots, onContinue, onFresh }: { snapshots: SnapshotHeader[]; onContinue: (id: string) => void; onFresh: () => void }) {
  return (
    <div className="snap-backdrop" onClick={onFresh}>
      <div className="snap-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="snap-dialog-head">
          {snapshots.length} snapshot{snapshots.length > 1 ? 's' : ''} for this project
        </div>
        <div className="snap-dialog-sub">Continue one, or start a fresh session.</div>
        <ul className="snap-dialog-list">
          {snapshots.map((s) => (
            <li key={s.id}>
              <button onClick={() => onContinue(s.id)}>
                <span className="snap-dialog-label">{s.label || '(unlabeled)'}</span>
                <span className="snap-dialog-when">{fmtUtc(s.savedUtc)}</span>
              </button>
            </li>
          ))}
        </ul>
        <button className="snap-fresh" onClick={onFresh}>
          Start fresh
        </button>
      </div>
    </div>
  )
}

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const conn = useRef<signalR.HubConnection | null>(null)
  const [connected, setConnected] = useState(false)
  const [baseline, setBaseline] = useState<ProjectModel | null>(null)
  const [journal, setJournal] = useState<JournalEvent[]>([]) // shared design + topology event list
  const [redo, setRedo] = useState<JournalEvent[]>([])
  const [rev, setRev] = useState(0) // bumps on every working-IR change; re-keys the canvas so the box re-renders
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [genMsg, setGenMsg] = useState('')
  const [mode, setMode] = useState<'design' | 'topology'>('design')
  const [assemblies, setAssemblies] = useState<AssemblyModel[] | null>(null) // topology baseline; null = not yet loaded
  const [openSite, setOpenSite] = useState<{ asmPath: string; siteName: string } | null>(null) // drilled-into site
  const [openRefs, setOpenRefs] = useState<{ asmPath: string } | null>(null) // open references view (per assembly)
  const [snapshots, setSnapshots] = useState<SnapshotHeader[]>([]) // saved snapshots for the open project
  const [currentSnapshot, setCurrentSnapshot] = useState<{ id: string; label: string } | null>(null) // one being worked from
  const [baselineUtc, setBaselineUtc] = useState('') // when the current baseline IR was captured (open / last Generate)
  const [snapPrompt, setSnapPrompt] = useState(false) // show the continue/fresh prompt on open
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'type' | 'ns'; target: string } | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renamingNs, setRenamingNs] = useState<string | null>(null) // full namespace being leaf-renamed
  const [newTypeNs, setNewTypeNs] = useState<string | null>(null) // stable prefix for the New Type dialog
  const [deleteNs, setDeleteNs] = useState<string | null>(null) // namespace pending a delete/move-up choice
  const [movingType, setMovingType] = useState<string | null>(null) // type key pending a "Move to…" target

  const working = useMemo(
    () => (baseline ? (journal.filter((e) => !isTopo(e)) as Entry[]).reduce(applyEntry, baseline) : null),
    [baseline, journal],
  )
  const selected = useMemo(
    () => working?.types.find((t) => key(t) === selectedKey) ?? null,
    [working, selectedKey],
  )
  const root = useMemo(() => buildTree(working?.types ?? []), [working])

  // Each known (project) type → its [Parameter] names. Used to offer parameters on instances and to prune stale
  // Config entries whose parameter no longer exists on the type (else the generator emits a call for a missing param).
  const typeParams = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const t of working?.types ?? [])
      m.set(key(t), t.members.filter((mm) => mm.facets.includes('Parameter')).map((mm) => mm.name))
    return m
  }, [working])

  // Each known type → its reference field names (both intra [Reference<T>] and cross [CrossReference<T>]) and its
  // [ServiceRef] member names (from the design IR). Used to prune instance ref/dep bindings whose field no longer
  // exists (else the generator wires a missing reference).
  const typeRefNames = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const t of working?.types ?? [])
      m.set(key(t), new Set(t.associations.filter((a) => a.kind === 'Reference' || a.kind === 'CrossReference').map((a) => a.name)))
    return m
  }, [working])
  const typeDepMembers = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const t of working?.types ?? [])
      m.set(key(t), new Set(t.associations.filter((a) => a.kind === 'ServiceDep').map((a) => a.name)))
    return m
  }, [working])

  const openPath = async (p: string) => {
    if (!conn.current || !p.trim()) return
    setBusy(true)
    setError('')
    setBaseline(null)
    setSelectedKey(null)
    setJournal([])
    setRedo([])
    setRev(0)
    setAssemblies(null)
    setOpenSite(null)
    setOpenRefs(null)
    setCurrentSnapshot(null)
    setSnapshots([])
    setSnapPrompt(false)
    const path = p.trim()
    try {
      // Eager-load both the design IR and the topology so the baseline captured here is complete (snapshots hash both).
      setBaseline(await conn.current.invoke<ProjectModel>('OpenProject', path))
      try {
        setAssemblies(await conn.current.invoke<AssemblyModel[]>('OpenAssemblies', path))
      } catch {
        setAssemblies([]) // a project with no/broken assemblies still opens for design editing
      }
      setBaselineUtc(new Date().toISOString())
      const snaps = await conn.current.invoke<SnapshotHeader[]>('ListSnapshots', path)
      setSnapshots(snaps)
      setSnapPrompt(snaps.length > 0)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  // Assemblies are eager-loaded on open now, so this just switches the tab (kept as a guarded refetch fallback).
  const showTopology = async () => {
    setMode('topology')
    if (assemblies !== null || !conn.current || !baseline) return
    try {
      setAssemblies(await conn.current.invoke<AssemblyModel[]>('OpenAssemblies', baseline.path))
    } catch (e) {
      setError(String(e))
      setAssemblies([])
    }
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────────

  // Save the current baseline IR + pending journal under a label (re-saving the current snapshot overwrites it).
  const saveSnapshot = async (label: string) => {
    if (!conn.current || !baseline || !assemblies) return
    const savedUtc = new Date().toISOString()
    const snap: Snapshot = {
      schema: 1,
      id: currentSnapshot?.id ?? snapId(),
      label,
      baselineCapturedUtc: baselineUtc || savedUtc,
      savedUtc,
      baseline: { hash: hashIr(baseline, assemblies), ir: { project: baseline, assemblies } },
      journal,
    }
    try {
      const res = await conn.current.invoke<{ id: string; path: string }>('SaveSnapshot', baseline.path, JSON.stringify(snap))
      setCurrentSnapshot({ id: res.id, label })
      setSnapshots(await conn.current.invoke<SnapshotHeader[]>('ListSnapshots', baseline.path))
      setGenMsg('Snapshot saved ✓')
    } catch (e) {
      setError(String(e))
    }
  }

  // Continue a saved snapshot: re-hash the live baseline and abort on drift (this sprint the journal only replays onto
  // the exact IR it was captured against); otherwise adopt its journal.
  const continueSnapshot = async (id: string) => {
    setSnapPrompt(false)
    if (!conn.current || !baseline || !assemblies) return
    try {
      const raw = await conn.current.invoke<string | null>('LoadSnapshot', baseline.path, id)
      if (!raw) {
        setError('That snapshot could not be found.')
        return
      }
      const snap = JSON.parse(raw) as Snapshot
      if (snap.baseline.hash !== hashIr(baseline, assemblies)) {
        setError(`Can't continue "${snap.label}": the project's design/topology changed since this snapshot was captured. Start fresh instead.`)
        return
      }
      setJournal(snap.journal)
      setRedo([])
      setRev((r) => r + 1)
      setCurrentSnapshot({ id: snap.id, label: snap.label })
      setBaselineUtc(snap.baselineCapturedUtc)
      setGenMsg(`Continuing "${snap.label}" · ${snap.journal.length} change${snap.journal.length === 1 ? '' : 's'}`)
    } catch (e) {
      setError(String(e))
    }
  }

  // Working topology = baseline folded through the topology events, then Config pruned to each type's real parameters
  // (so removing a parameter in Design drops its stale Config here and from the write-back).
  const workingAssemblies = useMemo(() => {
    if (!assemblies) return null
    const folded = (journal.filter(isTopo) as TopoAction[]).reduce(applyTopo, assemblies)
    const prune = (config: Record<string, string>, type: string) => {
      const valid = typeParams.get(type)
      if (!valid) return config // not a known project type — can't validate, leave as-is
      return Object.fromEntries(Object.entries(config).filter(([k]) => valid.includes(k)))
    }
    // Drop ref/dep bindings whose [Reference<T>]/[CrossReference<T>]/[ServiceRef] field was removed in Design (mirrors the Config prune).
    const pruneRefs = (refs: ReferenceBinding[], type: string) => {
      const valid = typeRefNames.get(type)
      return valid ? refs.filter((r) => valid.has(r.name)) : refs
    }
    const pruneDeps = (deps: DepBinding[], type: string) => {
      const valid = typeDepMembers.get(type)
      return valid ? deps.filter((d) => valid.has(d.member)) : deps
    }
    const pruneModels = (models: ModelInstance[]): ModelInstance[] =>
      models.map((mm) => ({
        ...mm,
        config: prune(mm.config, mm.type),
        refs: pruneRefs(mm.refs, mm.type),
        deps: pruneDeps(mm.deps, mm.type),
        containers: mm.containers.map((c) => ({ ...c, children: pruneModels(c.children) })),
      }))
    return folded.map((a) => ({
      ...a,
      services: a.services.map((s) => ({ ...s, config: prune(s.config, s.type) })),
      sites: a.sites.map((s) => ({ ...s, models: pruneModels(s.models) })),
    }))
  }, [assemblies, journal, typeParams, typeRefNames, typeDepMembers])
  const drilledSite = useMemo(() => {
    if (!openSite || !workingAssemblies) return null
    const asm = workingAssemblies.find((x) => x.path === openSite.asmPath)
    const site = asm?.sites.find((s) => s.name === openSite.siteName)
    return asm && site ? { asm, site } : null
  }, [openSite, workingAssemblies])
  const drilledRefs = useMemo(() => (openRefs && workingAssemblies ? workingAssemblies.find((x) => x.path === openRefs.asmPath) ?? null : null), [openRefs, workingAssemblies])

  // A type's [Parameter] member names (from the design IR) — so an instance offers them even when unset in the assembly.
  const paramsOf = (fqType: string) => typeParams.get(fqType) ?? []

  // A model type's containers (its [Contains<T>] decorators) — type-dictated, so even empty ones show as lines.
  const containersOf = (fqType: string) =>
    working?.types.find((t) => key(t) === fqType)?.associations.filter((a) => a.kind === 'Containment').map((a) => ({ name: a.name, elementType: a.target })) ?? []

  const modelTypes = useMemo(() => (working?.types ?? []).filter((t) => t.kind === 'Model'), [working])
  // Model types assignable to a container's element type T (T itself or anything that inherits/implements it).
  const candidatesOf = (elementType: string) =>
    modelTypes
      .filter((t) => key(t) === elementType || t.associations.some((a) => a.kind === 'Inheritance' && a.target === elementType))
      .map((t) => ({ fqn: key(t), label: `${t.name} (${t.namespace})` }))

  // Every project model type, for the add-root-model dropdown (a root may be any model, unconstrained by a container).
  const allModels = useMemo(
    () => modelTypes.map((t) => ({ fqn: key(t), label: `${t.name} (${t.namespace})` })).sort((a, b) => a.label.localeCompare(b.label)),
    [modelTypes],
  )
  const onAddRootModel = (asm: string, site: string, name: string, type: string) =>
    dispatch({ op: 'addRootModel', asm, site, name, type })
  const onAddInstance = (asm: string, parentPath: string, container: string, name: string, type: string) =>
    dispatch({ op: 'addInstance', asm, parentPath, container, name, type })
  const onMoveInstance = (asm: string, path: string, toParentPath: string, toContainer: string) =>
    dispatch({ op: 'moveInstance', asm, path, toParentPath, toContainer })
  // Deleting a non-empty instance drops its whole subtree — confirm first so a populated container isn't lost by a stray click.
  const onRemoveInstance = (asm: string, path: string) => {
    const a = workingAssemblies?.find((x) => x.path === asm)
    const inst = a && findInstanceAt(a.sites.flatMap((s) => s.models), pathSegs(path, a.name))
    const kids = inst ? inst.containers.reduce((n, c) => n + c.children.length, 0) : 0
    if (kids > 0 && !window.confirm(`Delete "${inst!.name}" and its ${kids} contained instance${kids === 1 ? '' : 's'}?`)) return
    dispatch({ op: 'removeInstance', asm, path })
  }
  const onSetInstanceConfig = (asm: string, path: string, key: string, value: string) =>
    dispatch({ op: 'setInstanceConfig', asm, path, key, value })

  // References view helpers: a type's reference fields (intra [Reference<T>] tagged isCross:false, cross
  // [CrossReference<T>] tagged isCross:true) / [ServiceRef] fields, and one-level assignability to a target T.
  const refFieldsOf = (fqType: string) =>
    working?.types.find((t) => key(t) === fqType)?.associations
      .filter((a) => a.kind === 'Reference' || a.kind === 'CrossReference')
      .map((a) => ({ name: a.name, target: a.target, isCross: a.kind === 'CrossReference' })) ?? []
  const serviceRefsOf = (fqType: string) =>
    working?.types.find((t) => key(t) === fqType)?.associations.filter((a) => a.kind === 'ServiceDep').map((a) => ({ member: a.name, target: a.target })) ?? []
  const assignable = (type: string, target: string) =>
    type === target || !!working?.types.find((t) => key(t) === type)?.associations.some((a) => a.kind === 'Inheritance' && a.target === target)
  const onSetReference = (asm: string, path: string, name: string, targets: string[], isCross: boolean) => dispatch({ op: 'setReference', asm, path, name, targets, isCross })
  const onSetServiceDep = (asm: string, path: string, member: string, service: string) => dispatch({ op: 'setServiceDep', asm, path, member, service })
  const refsData: RefsData = { refFieldsOf, serviceRefsOf, assignable, services: drilledRefs?.services ?? [], onSetReference, onSetServiceDep }

  // The project's service types, for the add-service dropdown: "ClassName (Namespace)".
  const serviceTypes = useMemo(
    () =>
      (working?.types ?? [])
        .filter((t) => t.kind === 'Service' || t.kind === 'LooselyCoupledService')
        .map((t) => ({ fqn: key(t), label: `${t.name} (${t.namespace})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [working],
  )

  const topoHandlers: TopoHandlers = {
    onOpenSite: (asmPath, siteName) => setOpenSite({ asmPath, siteName }),
    onOpenRefs: (asmPath) => setOpenRefs({ asmPath }),
    onRenameSimulator: (asm, to) => dispatch({ op: 'renameSimulator', asm, to }),
    onAddSite: (asm) => dispatch({ op: 'addSite', asm, name: randomName() }),
    onRemoveSite: (asm, name) => dispatch({ op: 'removeSite', asm, name }),
    onRenameSite: (asm, from, to) => from !== to && dispatch({ op: 'renameSite', asm, from, to }),
    onSetSiteMaxEvents: (asm, name, v) => {
      const n = parseInt(v, 10)
      dispatch({ op: 'setSiteMaxEvents', asm, name, maxEvents: Number.isNaN(n) ? 64 : Math.max(10, n) })
    },
    onAddService: (asm, type) => {
      const target = workingAssemblies?.find((x) => x.path === asm)
      dispatch({ op: 'addService', asm, name: uniqueName('Service', new Set(target?.services.map((s) => s.name))), type })
    },
    onRemoveService: (asm, name) => dispatch({ op: 'removeService', asm, name }),
    onRenameService: (asm, from, to) => from !== to && dispatch({ op: 'renameService', asm, from, to }),
    onSetServiceConfig: (asm, name, key, value) => dispatch({ op: 'setServiceConfig', asm, name, key, value }),
  }

  // Edit commands. dispatch appends an action (clearing the redo stack); undo/redo/discard move
  // between journal and redo. Every one bumps rev so the (uncontrolled) canvas remounts and re-reads.
  const dispatch = (a: JournalEvent) => {
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

  // Generate: replay the whole shared journal. Write the topology YAML *first* so the code write-back's compile-verify
  // sees a consistent assembly (e.g. a parameter removed in Design and its now-pruned Config land together). Baselines
  // update and the journal clears only when both succeed.
  const generate = async () => {
    if (!conn.current || !journal.length) return
    const designActions = flatten(journal.filter((e) => !isTopo(e)) as Entry[])
    // Write the topology whenever the working assemblies differ from the baseline — that includes Config pruned by a
    // design edit (e.g. a removed parameter), which has no topology *action* of its own.
    const topoChanged = !!(assemblies && workingAssemblies && JSON.stringify(workingAssemblies) !== JSON.stringify(assemblies))
    setGenMsg('Generating…')
    setError('')
    try {
      if (topoChanged && workingAssemblies) {
        const res = await conn.current.invoke<{ ok: boolean; errors: string[] }>('WriteAssemblies', workingAssemblies)
        if (!res.ok) {
          setGenMsg('Generate failed')
          setError(res.errors.join('\n') || 'unknown error')
          return
        }
      }
      let newBaseline = baseline
      if (designActions.length && baseline) {
        const res = await conn.current.invoke<{ ok: boolean; errors: string[]; model: ProjectModel | null }>('Generate', baseline.path, designActions)
        if (!res.ok || !res.model) {
          setGenMsg('Generate failed')
          setError(res.errors.join('\n') || 'unknown error')
          return
        }
        newBaseline = res.model
      }
      if (designActions.length && newBaseline) setBaseline(newBaseline)
      if (topoChanged && workingAssemblies) setAssemblies(workingAssemblies)
      setJournal([])
      setRedo([])
      setRev((r) => r + 1)
      setGenMsg('Generated ✓')

      // The project now embodies the journal — capture a fresh baseline and, if working from a snapshot, re-save it
      // reset to {new baseline, []} at the same id (design: post-Generate the snapshot resets to the new baseline).
      const nb = designActions.length && newBaseline ? newBaseline : baseline
      const na = topoChanged && workingAssemblies ? workingAssemblies : assemblies
      const utc = new Date().toISOString()
      setBaselineUtc(utc)
      if (currentSnapshot && nb && na) {
        const snap: Snapshot = {
          schema: 1,
          id: currentSnapshot.id,
          label: currentSnapshot.label,
          baselineCapturedUtc: utc,
          savedUtc: utc,
          baseline: { hash: hashIr(nb, na), ir: { project: nb, assemblies: na } },
          journal: [],
        }
        await conn.current.invoke('SaveSnapshot', nb.path, JSON.stringify(snap))
        setSnapshots(await conn.current.invoke<SnapshotHeader[]>('ListSnapshots', nb.path))
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

  // ── Tree ops (types + namespaces) ─────────────────────────────────────────────

  const onContext = (e: React.MouseEvent, kind: 'type' | 'ns', target: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, kind, target })
  }

  const onRenameType = (typeKey: string, to: string) => {
    setRenamingKey(null)
    const t = to.trim()
    if (!t || t === nameOf(typeKey)) return
    const newKey = nsOf(typeKey) ? nsOf(typeKey) + '.' + t : t
    if (working?.types.some((x) => key(x) === newKey)) return // name collision
    dispatch({ op: 'renameType', typeKey, to: t })
    if (selectedKey === typeKey) setSelectedKey(newKey)
  }

  const onRenameCancel = () => setRenamingKey(null)

  const onRemoveType = (typeKey: string) => {
    dispatch({ op: 'removeType', typeKey })
    if (selectedKey === typeKey) setSelectedKey(null)
  }

  const onRenameNamespace = (oldNs: string, leafRaw: string) => {
    setRenamingNs(null)
    const leaf = leafRaw.trim()
    const oldLeaf = oldNs.includes('.') ? oldNs.slice(oldNs.lastIndexOf('.') + 1) : oldNs
    if (!leaf || leaf === oldLeaf || leaf.includes('.')) return
    const parent = oldNs.includes('.') ? oldNs.slice(0, oldNs.lastIndexOf('.')) : ''
    const newNs = parent ? parent + '.' + leaf : leaf
    if (working?.types.some((t) => t.namespace === newNs || t.namespace.startsWith(newNs + '.'))) return // would merge into an existing namespace
    dispatch({ op: 'renameNamespace', typeKey: oldNs, to: newNs })
    if (selectedKey) {
      const sns = nsOf(selectedKey)
      if (sns === oldNs || sns.startsWith(oldNs + '.'))
        setSelectedKey((sns === oldNs ? newNs : newNs + sns.slice(oldNs.length)) + '.' + nameOf(selectedKey))
    }
  }
  const onRenameNsCancel = () => setRenamingNs(null)

  const typesUnder = (ns: string) => (working?.types ?? []).filter((t) => t.namespace === ns || t.namespace.startsWith(ns + '.'))

  const onDeleteNamespace = (ns: string) => {
    setDeleteNs(null)
    const victims = typesUnder(ns)
    if (!victims.length) return
    dispatch({ op: 'bundle', label: `Delete namespace ${ns}`, actions: victims.map((t) => ({ op: 'removeType', typeKey: key(t) })) })
    if (selectedKey && victims.some((t) => key(t) === selectedKey)) setSelectedKey(null)
  }

  // Reparent everything under a namespace one level up (strip its leaf segment), then the namespace is gone.
  const onMoveNamespaceUp = (ns: string) => {
    setDeleteNs(null)
    const victims = typesUnder(ns)
    if (!victims.length) return
    const leafIndex = ns.split('.').length - 1
    const stripLeaf = (typeNs: string) => typeNs.split('.').filter((_, i) => i !== leafIndex).join('.')
    dispatch({ op: 'bundle', label: `Move ${ns} contents up`, actions: victims.map((t) => ({ op: 'moveType', typeKey: key(t), to: stripLeaf(t.namespace) })) })
    if (selectedKey && victims.some((t) => key(t) === selectedKey)) {
      const sns = stripLeaf(nsOf(selectedKey))
      setSelectedKey(sns ? sns + '.' + nameOf(selectedKey) : nameOf(selectedKey))
    }
  }

  const onMoveType = (typeKey: string, targetNs: string) => {
    setMovingType(null)
    const to = targetNs.trim()
    if (to === nsOf(typeKey)) return
    const newKey = to ? to + '.' + nameOf(typeKey) : nameOf(typeKey)
    if (working?.types.some((t) => key(t) === newKey)) return // collision
    dispatch({ op: 'moveType', typeKey, to })
    if (selectedKey === typeKey) setSelectedKey(newKey)
  }

  // Reparent a whole namespace under another (drag a folder onto a folder): its subtree's prefix is rewritten.
  const onReparentNamespace = (sourceNs: string, targetNs: string) => {
    if (targetNs === sourceNs || targetNs.startsWith(sourceNs + '.')) return // into itself / a descendant → cycle
    const leaf = sourceNs.includes('.') ? sourceNs.slice(sourceNs.lastIndexOf('.') + 1) : sourceNs
    const newBase = targetNs ? targetNs + '.' + leaf : leaf
    if (newBase === sourceNs) return // already there
    const victims = typesUnder(sourceNs)
    if (!victims.length) return
    dispatch({
      op: 'bundle',
      label: `Move ${sourceNs} → ${newBase}`,
      actions: victims.map((t) => ({ op: 'moveType', typeKey: key(t), to: newBase + t.namespace.slice(sourceNs.length) })),
    })
    if (selectedKey && victims.some((t) => key(t) === selectedKey))
      setSelectedKey(newBase + nsOf(selectedKey).slice(sourceNs.length) + '.' + nameOf(selectedKey))
  }

  const onTreeDrop = (dragged: { kind: 'type' | 'ns'; id: string }, targetNs: string) => {
    if (dragged.kind === 'type') onMoveType(dragged.id, targetNs)
    else onReparentNamespace(dragged.id, targetNs)
  }

  const onNewType = (typeKey: string, kind: string) => {
    setNewTypeNs(null)
    if (working?.types.some((t) => key(t) === typeKey)) return // collision
    dispatch({ op: 'addType', typeKey, kind })
    setSelectedKey(typeKey)
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
          <span className="mode-tabs">
            <button className={mode === 'design' ? 'active' : ''} onClick={() => setMode('design')}>
              Design
            </button>
            <button className={mode === 'topology' ? 'active' : ''} onClick={showTopology}>
              Topology
            </button>
          </span>
        )}
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
            <button className="gen" onClick={generate} disabled={!journal.length} title="Write all pending changes back (code + topology)">
              Generate
            </button>
            <SnapshotControls current={currentSnapshot} onSave={saveSnapshot} />
            {genMsg && <span className="gen-msg">{genMsg}</span>}
          </span>
        )}
      </header>
      {snapPrompt && snapshots.length > 0 && <SnapshotPrompt snapshots={snapshots} onContinue={continueSnapshot} onFresh={() => setSnapPrompt(false)} />}
      <div className="body">
        {mode === 'topology' ? (
          drilledRefs ? (
            <main className="topo-site-main">
              <RefsView asm={drilledRefs} data={refsData} rev={rev} onBack={() => setOpenRefs(null)} />
            </main>
          ) : drilledSite ? (
            <main className="topo-site-main">
              <SiteView
                asm={drilledSite.asm}
                site={drilledSite.site}
                rev={rev}
                onBack={() => setOpenSite(null)}
                ctx={{ asmPath: drilledSite.asm.path, paramsOf, containersOf, candidatesOf, allModels, onAddRootModel, onAddInstance, onMoveInstance, onRemoveInstance, onSetInstanceConfig }}
              />
            </main>
          ) : (
            <main className="topo-main">
              {error && <div className="error">{error}</div>}
              <TopologyView assemblies={workingAssemblies} paramsOf={paramsOf} serviceTypes={serviceTypes} h={topoHandlers} />
            </main>
          )
        ) : (
        <>
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
                <span>
                  {working.name} — {working.types.length} types
                </span>
                <button className="new-type-top" title="New top-level type" onClick={() => setNewTypeNs('')}>
                  + type
                </button>
              </div>
              {[...root.children.values()]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <NsFolder
                    key={c.name}
                    node={c}
                    depth={0}
                    ns={c.name}
                    onSelect={setSelectedKey}
                    selectedKey={selectedKey}
                    onContext={onContext}
                    renamingKey={renamingKey}
                    onRenameType={onRenameType}
                    onRenameCancel={onRenameCancel}
                    renamingNs={renamingNs}
                    onRenameNamespace={onRenameNamespace}
                    onRenameNsCancel={onRenameNsCancel}
                    onTreeDrop={onTreeDrop}
                  />
                ))}
              {[...root.types].sort(byKindThenName).map((t) => (
                <TypeRow
                  key={t.name}
                  t={t}
                  depth={0}
                  onSelect={setSelectedKey}
                  selectedKey={selectedKey}
                  onContext={onContext}
                  renamingKey={renamingKey}
                  onRenameType={onRenameType}
                  onRenameCancel={onRenameCancel}
                  renamingNs={renamingNs}
                  onRenameNamespace={onRenameNamespace}
                  onRenameNsCancel={onRenameNsCancel}
                  onTreeDrop={onTreeDrop}
                />
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
        </>
        )}
      </div>

      {menu && (
        <div
          className="ctx-backdrop"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(null)
          }}
        >
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            {menu.kind === 'type' ? (
              <>
                <button onClick={() => { setRenamingKey(menu.target); setMenu(null) }}>Rename</button>
                <button onClick={() => { setMovingType(menu.target); setMenu(null) }}>Move to…</button>
                <button className="danger" onClick={() => { onRemoveType(menu.target); setMenu(null) }}>Delete</button>
              </>
            ) : (
              <>
                <button onClick={() => { setRenamingNs(menu.target); setMenu(null) }}>Rename</button>
                <button onClick={() => { setNewTypeNs(menu.target); setMenu(null) }}>New type…</button>
                <button className="danger" onClick={() => { setDeleteNs(menu.target); setMenu(null) }}>Delete namespace…</button>
              </>
            )}
          </div>
        </div>
      )}

      {newTypeNs !== null && <NewTypeDialog stable={newTypeNs} onCreate={onNewType} onCancel={() => setNewTypeNs(null)} />}
      {deleteNs !== null && (
        <DeleteNamespaceDialog
          ns={deleteNs}
          count={typesUnder(deleteNs).length}
          onDeleteAll={() => onDeleteNamespace(deleteNs)}
          onMoveUp={() => onMoveNamespaceUp(deleteNs)}
          onCancel={() => setDeleteNs(null)}
        />
      )}
      {movingType !== null && <MoveTypeDialog typeKey={movingType} onMove={onMoveType} onCancel={() => setMovingType(null)} />}
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
