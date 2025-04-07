import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { parse } from 'url'
import { query } from './db-ws'

// Store active connections with sessionId and userId
const connections = new Map<string, {ws: WebSocket, sessionId: string, userId: string}>()

// Create HTTP server
const server = createServer()
server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
  }
})

// Create WebSocket server
const wss = new WebSocketServer({ server })

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const { query: queryParams } = parse(req.url || '', true)
  const sessionId = queryParams.sessionId as string
  const userId = queryParams.userId as string

  if (!sessionId || !userId) {
    ws.close(1008, 'Missing sessionId or userId')
    return
  }

  // Store the connection with both IDs for better filtering
  const connectionId = `${userId}-${sessionId}`
  connections.set(connectionId, {ws, sessionId, userId})
  console.log(`New connection: ${connectionId}`)

  // Notify other participants in the session
  broadcastToSession(sessionId, userId, {
    type: 'participant-joined',
    userId
  })

  // Handle messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())
      
      // Forward the message to other participants in the session
      if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
        broadcastToSession(sessionId, userId, message)
      } else if (message.type === 'chat') {
        // Save chat message to database
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
  // Get all participants in the session except sender
  const participants = Array.from(connections.entries())
    .filter(([_, connInfo]) => connInfo.sessionId === sessionId)
    .filter(([connId]) => !connId.startsWith(senderId))

  if (participants.length === 0) {
    // If no other participants, notify the sender
    const senderConn = Array.from(connections.entries())
      .find(([connId]) => connId.startsWith(senderId))
    
    if (senderConn) {
      const [_, { ws }] = senderConn
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'no-participant'
        }))
      }
    }
    return
  }

  // Send message to all other participants
  participants.forEach(([_, { ws }]) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  })
}

// Helper function to save chat messages
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

// Start the server
const PORT = parseInt(process.env.PORT || '3001')
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`)
})
