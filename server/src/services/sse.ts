import { Response } from 'express';
import { SSEEvent, SSEConnection, ConnectionEvent, HeartbeatEvent } from '@mini-infra/types';

interface ClientConnection {
  response: Response;
  sessionId: string;
  jobId?: string;
  connected: boolean;
  lastHeartbeat: Date;
}

export class SSEService {
  private connections: Map<string, ClientConnection> = new Map();
  private heartbeatInterval: NodeJS.Timeout | undefined;
  private readonly heartbeatIntervalMs = 30000; // 30 seconds
  private readonly connectionTimeoutMs = 60000; // 60 seconds

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Connects a client to the SSE service
   */
  connect(sessionId: string, response: Response, jobId?: string): void {
    // Set SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Create connection
    const connection: ClientConnection = {
      response,
      sessionId,
      jobId,
      connected: true,
      lastHeartbeat: new Date()
    };

    // Store connection
    this.connections.set(sessionId, connection);

    // Handle client disconnect
    response.on('close', () => {
      this.disconnect(sessionId);
    });

    response.on('error', (error) => {
      console.error(`SSE connection error for session ${sessionId}:`, error);
      this.disconnect(sessionId);
    });

    // Send initial connection confirmation
    const connectionEvent: ConnectionEvent = {
      type: 'connected',
      timestamp: new Date().toISOString(),
      sessionId,
      jobId
    };
    this.sendToClient(sessionId, connectionEvent);

    console.log(`SSE client connected: ${sessionId}${jobId ? ` (job: ${jobId})` : ''}`);
  }

  /**
   * Disconnects a client from the SSE service
   */
  disconnect(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.connected = false;
      
      try {
        if (!connection.response.destroyed) {
          connection.response.end();
        }
      } catch (error) {
        console.error(`Error closing SSE connection for session ${sessionId}:`, error);
      }
      
      this.connections.delete(sessionId);
      console.log(`SSE client disconnected: ${sessionId}`);
    }
  }

  /**
   * Broadcasts an event to a specific session
   */
  broadcast(sessionId: string, event: Partial<SSEEvent>): void {
    const fullEvent: SSEEvent = {
      timestamp: new Date().toISOString(),
      sessionId,
      ...event
    } as SSEEvent;

    this.sendToClient(sessionId, fullEvent);
  }

  /**
   * Broadcasts an event to all sessions associated with a specific job
   */
  broadcastToJob(jobId: string, event: Partial<SSEEvent>): void {
    for (const [sessionId, connection] of this.connections) {
      if (connection.jobId === jobId && connection.connected) {
        const fullEvent: SSEEvent = {
          timestamp: new Date().toISOString(),
          sessionId,
          jobId,
          ...event
        } as SSEEvent;

        this.sendToClient(sessionId, fullEvent);
      }
    }
  }

  /**
   * Broadcasts an event to all connected clients
   */
  broadcastToAll(event: Partial<SSEEvent>): void {
    for (const [sessionId] of this.connections) {
      this.broadcast(sessionId, event);
    }
  }

  /**
   * Sends a heartbeat to maintain connection
   */
  sendHeartbeat(sessionId: string): void {
    const heartbeatEvent: HeartbeatEvent = {
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
      sessionId
    };
    this.sendToClient(sessionId, heartbeatEvent);
  }

  /**
   * Gets connection information for a session
   */
  getConnection(sessionId: string): SSEConnection | null {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return null;
    }

    return {
      sessionId: connection.sessionId,
      jobId: connection.jobId,
      connected: connection.connected,
      lastHeartbeat: connection.lastHeartbeat
    };
  }

  /**
   * Gets all active connections
   */
  getAllConnections(): SSEConnection[] {
    return Array.from(this.connections.values()).map(conn => ({
      sessionId: conn.sessionId,
      jobId: conn.jobId,
      connected: conn.connected,
      lastHeartbeat: conn.lastHeartbeat
    }));
  }

  /**
   * Gets the count of active connections
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Private method to send event to a specific client
   */
  private sendToClient(sessionId: string, event: SSEEvent): void {
    const connection = this.connections.get(sessionId);
    if (!connection || !connection.connected) {
      return;
    }

    try {
      const eventData = `data: ${JSON.stringify(event)}\n\n`;
      
      if (!connection.response.destroyed) {
        connection.response.write(eventData);
        connection.lastHeartbeat = new Date();
      } else {
        // Connection is destroyed, clean up
        this.disconnect(sessionId);
      }
    } catch (error) {
      console.error(`Error sending SSE event to session ${sessionId}:`, error);
      this.disconnect(sessionId);
    }
  }

  /**
   * Starts the heartbeat mechanism to maintain connections
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      const staleConnections: string[] = [];

      // Check for stale connections and send heartbeats
      for (const [sessionId, connection] of this.connections) {
        const timeSinceLastHeartbeat = now.getTime() - connection.lastHeartbeat.getTime();
        
        if (timeSinceLastHeartbeat > this.connectionTimeoutMs) {
          // Connection is stale, mark for removal
          staleConnections.push(sessionId);
        } else if (connection.connected) {
          // Send heartbeat to active connection
          this.sendHeartbeat(sessionId);
        }
      }

      // Clean up stale connections
      staleConnections.forEach(sessionId => {
        console.log(`Removing stale SSE connection: ${sessionId}`);
        this.disconnect(sessionId);
      });

      if (this.connections.size > 0) {
        console.log(`SSE heartbeat sent to ${this.connections.size} connections`);
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stops the heartbeat and cleans up all connections
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Disconnect all clients
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId);
    }

    console.log('SSE service shutdown complete');
  }
}

// Export singleton instance
export const sseService = new SSEService();