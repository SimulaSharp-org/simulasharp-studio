import { useEffect, useState } from 'react'
import { ReactFlow, Background, Controls } from '@xyflow/react'
import * as signalR from '@microsoft/signalr'
import '@xyflow/react/dist/style.css'

// Phase-0 placeholder graph — proves the React Flow layer renders; replaced by the real class/topology views.
const initialNodes = [
  { id: 'a', position: { x: 80, y: 80 }, data: { label: 'Class' } },
  { id: 'b', position: { x: 380, y: 220 }, data: { label: 'Ref' } },
]
const initialEdges = [{ id: 'a-b', source: 'a', target: 'b', label: 'references' }]

export default function App() {
  const [status, setStatus] = useState('connecting…')

  // Prove the SPA↔backend SignalR channel is live (same-origin /hub, served by the Host).
  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder().withUrl('/hub').build()
    conn
      .start()
      .then(() => conn.invoke<string>('Ping'))
      .then(setStatus)
      .catch((e) => setStatus('error: ' + e))
    return () => {
      void conn.stop()
    }
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <strong>SimulaSharp.Studio</strong>
        <span className="status">backend: {status}</span>
      </header>
      <div className="canvas">
        <ReactFlow defaultNodes={initialNodes} defaultEdges={initialEdges} fitView colorMode="dark">
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}
