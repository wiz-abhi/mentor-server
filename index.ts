import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { parse } from 'url'
import { query } from './db-ws'

// Store active connections with sessionId and userId
const connections = new Map<string, { ws: WebSocket, sessionId: string, userId: string }>()

// Create HTTP server
const server = createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400)
    res.end()
    return
  }

  const parsedUrl = parse(req.url, true)
  
  // Health check endpoint
  if (req.method === 'GET' && parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  
  // Other endpoints can return a simple 404
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server })

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const parsedUrl = parse(req.url || '', true)
  const queryParams = parsedUrl.query
  const sessionId = queryParams.sessionId as string
  const userId = queryParams.userId as string

  if (!sessionId || !userId) {
    ws.close(1008, 'Missing sessionId or userId')
    return
  }

  // Use a composite key for the connection
  const connectionId = `${userId}-${sessionId}`
  connections.set(connectionId, { ws, sessionId, userId })
  console.log(`New connection: ${connectionId}`)

  // Notify other participants in the session
  broadcastToSession(sessionId, userId, {
    type: 'participant-joined',
    userId
  })

  // Handle incoming messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())
      if (['offer', 'answer', 'ice-candidate'].includes(message.type)) {
        broadcastToSession(sessionId, userId, message)
      } else if (message.type === 'chat') {
        await saveChatMessage(sessionId, userId, message.message)
        broadcastToSession(sessionId, userId, message)
      }
    } catch (error) {
      console.error('Error handling message:', error)
    }
  })

  // Handle disconnection
  ws.on('close', () => {
    connections.delete(connectionId)
    console.log(`Connection closed: ${connectionId}`)
    broadcastToSession(sessionId, userId, {
      type: 'participant-left',
      userId
    })
  })

  // Handle errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${connectionId}:`, error)
    connections.delete(connectionId)
  })
})

// Helper function to broadcast to all participants in a session except the sender
function broadcastToSession(sessionId: string, senderId: string, message: any) {
  // Get all connections in the same session where the userId is not the senderId
  const participants = Array.from(connections.values())
    .filter(conn => conn.sessionId === sessionId && conn.userId !== senderId)

  // If no other participants, optionally notify the sender
  if (participants.length === 0) {
    const senderConn = Array.from(connections.values())
      .find(conn => conn.userId === senderId)
    if (senderConn && senderConn.ws.readyState === WebSocket.OPEN) {
      senderConn.ws.send(JSON.stringify({ type: 'no-participant' }))
    }
    return
  }

  // Send the message to each participant
  participants.forEach(conn => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message))
    }
  })
}

// Helper function to save chat messages to the database
async function saveChatMessage(sessionId: string, userId: string, message: any) {
  try {
    const result = await query(
      `SELECT notes FROM mentorship_sessions WHERE id = $1`,
      [sessionId]
    )

    const currentNotes = result.rows[0]?.notes ? JSON.parse(result.rows[0].notes) : []
    const updatedNotes = [...currentNotes, message]

    await query(
      `UPDATE mentorship_sessions SET notes = $1 WHERE id = $2`,
      [JSON.stringify(updatedNotes), sessionId]
    )
  } catch (error) {
    console.error('Error saving chat message:', error)
  }
}

// Start the server using the PORT environment variable (or default to 3001)
const PORT = parseInt(process.env.PORT || '3001', 10)
server.listen(PORT, () => {
  console.log(`HTTP + WebSocket server running on port ${PORT}`)
})
