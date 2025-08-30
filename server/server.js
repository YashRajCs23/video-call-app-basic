require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);

// Environment variables
const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const NODE_ENV = process.env.NODE_ENV || 'development';

// Configure CORS
app.use(cors({
  origin: CLIENT_URL,
  credentials: true
}));

// Basic middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    uptime: process.uptime()
  });
});

// Socket.io setup with enhanced configuration
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Data structures for room and user management
const rooms = new Map();
const socketToRoom = new Map();
const userProfiles = new Map();

// Utility functions
const getRoomInfo = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return null;
  
  return {
    roomId,
    users: Array.from(room).map(socketId => ({
      socketId,
      profile: userProfiles.get(socketId) || {}
    })),
    userCount: room.size
  };
};

const cleanupRoom = (roomId) => {
  const room = rooms.get(roomId);
  if (room && room.size === 0) {
    rooms.delete(roomId);
    console.log(`🗑️  Room ${roomId} deleted`);
    return true;
  }
  return false;
};

const leaveCurrentRoom = (socketId) => {
  const currentRoom = socketToRoom.get(socketId);
  if (!currentRoom) return null;

  const room = rooms.get(currentRoom);
  if (room) {
    room.delete(socketId);
    console.log(`👋 User ${socketId} left room ${currentRoom}`);
    
    // Notify other users in the room
    Array.from(room).forEach(otherSocketId => {
      io.to(otherSocketId).emit('user:left', { 
        socketId,
        roomId: currentRoom,
        userCount: room.size
      });
    });
    
    cleanupRoom(currentRoom);
  }
  
  socketToRoom.delete(socketId);
  return currentRoom;
};

// Enhanced logging
const log = (event, socketId, data = {}) => {
  const timestamp = new Date().toISOString();
  const roomId = socketToRoom.get(socketId);
  console.log(`[${timestamp}] ${event} | Socket: ${socketId?.substring(0, 8)} | Room: ${roomId} |`, data);
};

// Socket connection handling
io.on('connection', (socket) => {
  log('🔗 USER_CONNECTED', socket.id);
  
  // Store basic user profile
  userProfiles.set(socket.id, {
    connectedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString()
  });

  // Handle room joining with enhanced validation
  socket.on('room:join', ({ roomId }) => {
    try {
      // Validate room ID
      if (!roomId || typeof roomId !== 'string' || roomId.trim().length === 0) {
        socket.emit('error', { message: 'Invalid room ID' });
        return;
      }

      const cleanRoomId = roomId.trim().toLowerCase();
      
      // Check room capacity (limit to 2 users for 1-on-1 calls)
      const existingRoom = rooms.get(cleanRoomId);
      if (existingRoom && existingRoom.size >= 2 && !existingRoom.has(socket.id)) {
        socket.emit('error', { message: 'Room is full' });
        log('❌ ROOM_FULL', socket.id, { roomId: cleanRoomId });
        return;
      }

      // Leave current room if any
      leaveCurrentRoom(socket.id);

      // Join new room
      socket.join(cleanRoomId);
      socketToRoom.set(socket.id, cleanRoomId);
      
      if (!rooms.has(cleanRoomId)) {
        rooms.set(cleanRoomId, new Set());
      }
      
      const room = rooms.get(cleanRoomId);
      room.add(socket.id);

      log('🏠 ROOM_JOINED', socket.id, { roomId: cleanRoomId, userCount: room.size });

      // Update user activity
      const profile = userProfiles.get(socket.id);
      if (profile) {
        profile.lastActivity = new Date().toISOString();
        profile.currentRoom = cleanRoomId;
      }

      // Notify all users in the room about current state
      const roomInfo = getRoomInfo(cleanRoomId);
      const otherUsers = Array.from(room).filter(id => id !== socket.id);
      
      if (otherUsers.length > 0) {
        // Notify the new user about existing users
        socket.emit('user:joined', { 
          socketId: otherUsers[0], 
          roomId: cleanRoomId,
          roomInfo 
        });
        
        // Notify existing users about new user
        otherUsers.forEach(userId => {
          io.to(userId).emit('user:joined', { 
            socketId: socket.id, 
            roomId: cleanRoomId,
            roomInfo
          });
        });
      }

      // Send room info to the joining user
      socket.emit('room:joined', { roomInfo });

    } catch (error) {
      console.error('Error in room:join:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Handle outgoing call with validation
  socket.on('outgoing:call', ({ to, offer }) => {
    try {
      if (!to || !offer) {
        socket.emit('error', { message: 'Invalid call parameters' });
        return;
      }

      // Verify both users are in the same room
      const callerRoom = socketToRoom.get(socket.id);
      const receiverRoom = socketToRoom.get(to);
      
      if (!callerRoom || callerRoom !== receiverRoom) {
        socket.emit('error', { message: 'Users are not in the same room' });
        return;
      }

      log('📞 OUTGOING_CALL', socket.id, { to: to.substring(0, 8) });
      
      socket.to(to).emit('incoming:call', { 
        from: socket.id, 
        offer,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error in outgoing:call:', error);
      socket.emit('error', { message: 'Failed to make call' });
    }
  });

  // Handle call accepted
  socket.on('call:accepted', ({ to, answer }) => {
    try {
      if (!to || !answer) {
        socket.emit('error', { message: 'Invalid answer parameters' });
        return;
      }

      log('✅ CALL_ACCEPTED', socket.id, { to: to.substring(0, 8) });
      
      socket.to(to).emit('call:accepted', { 
        from: socket.id, 
        answer,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error in call:accepted:', error);
      socket.emit('error', { message: 'Failed to accept call' });
    }
  });

  // Handle ICE candidates with error handling
  socket.on('ice:candidate', ({ candidate, to }) => {
    try {
      if (!candidate || !to) {
        return; // ICE candidates can be null, so we just ignore invalid ones
      }

      socket.to(to).emit('ice:candidate', { 
        candidate, 
        from: socket.id 
      });

    } catch (error) {
      console.error('Error in ice:candidate:', error);
    }
  });

  // Handle call ended
  socket.on('call:ended', ({ to }) => {
    try {
      log('📴 CALL_ENDED', socket.id, { to: to?.substring(0, 8) });
      
      if (to) {
        socket.to(to).emit('call:ended', { 
          from: socket.id,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      console.error('Error in call:ended:', error);
    }
  });

  // Handle ping/pong for connection monitoring
  socket.on('ping', () => {
    socket.emit('pong');
    
    // Update user activity
    const profile = userProfiles.get(socket.id);
    if (profile) {
      profile.lastActivity = new Date().toISOString();
    }
  });

  // Handle user activity updates
  socket.on('user:activity', (data) => {
    const profile = userProfiles.get(socket.id);
    if (profile) {
      profile.lastActivity = new Date().toISOString();
      profile.activity = data;
    }
  });

  // Handle disconnection with comprehensive cleanup
  socket.on('disconnect', (reason) => {
    try {
      log('❌ USER_DISCONNECTED', socket.id, { reason });
      
      // Leave current room and notify other users
      const leftRoom = leaveCurrentRoom(socket.id);
      
      // Clean up user profile
      userProfiles.delete(socket.id);
      
      // If user was in a room, notify remaining users
      if (leftRoom) {
        const room = rooms.get(leftRoom);
        if (room && room.size > 0) {
          Array.from(room).forEach(remainingSocketId => {
            io.to(remainingSocketId).emit('user:disconnected', {
              socketId: socket.id,
              roomId: leftRoom,
              reason,
              timestamp: new Date().toISOString()
            });
          });
        }
      }

    } catch (error) {
      console.error('Error in disconnect handler:', error);
    }
  });

  // Handle connection errors
  socket.on('error', (error) => {
    log('⚠️  SOCKET_ERROR', socket.id, { error: error.message });
  });
});

// Error handling middleware
io.engine.on('connection_error', (err) => {
  console.error('Connection error:', err.req);
  console.error('Error code:', err.code);
  console.error('Error message:', err.message);
  console.error('Error context:', err.context);
});

// Periodic cleanup of inactive rooms and users
const cleanupInterval = setInterval(() => {
  const now = new Date();
  const maxInactiveTime = 30 * 60 * 1000; // 30 minutes
  
  let cleanedUsers = 0;
  let cleanedRooms = 0;
  
  // Clean up inactive users
  userProfiles.forEach((profile, socketId) => {
    const lastActivity = new Date(profile.lastActivity);
    if (now - lastActivity > maxInactiveTime) {
      userProfiles.delete(socketId);
      leaveCurrentRoom(socketId);
      cleanedUsers++;
    }
  });
  
  // Clean up empty rooms
  rooms.forEach((room, roomId) => {
    if (room.size === 0) {
      rooms.delete(roomId);
      cleanedRooms++;
    }
  });
  
  if (cleanedUsers > 0 || cleanedRooms > 0) {
    console.log(`🧹 Cleanup completed: ${cleanedUsers} users, ${cleanedRooms} rooms`);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  
  clearInterval(cleanupInterval);
  
  // Notify all connected users
  io.emit('server:shutdown', {
    message: 'Server is shutting down',
    timestamp: new Date().toISOString()
  });
  
  // Close all connections
  io.close(() => {
    console.log('✅ All connections closed');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${NODE_ENV}`);
  console.log(`🔗 Client URL: ${CLIENT_URL}`);
  console.log(`⚡ Socket.io server ready for connections`);
  console.log(`📊 Health check available at: http://localhost:${PORT}/health`);
  
  if (NODE_ENV === 'development') {
    console.log(`\n📱 Test the app:`);
    console.log(`   Frontend: ${CLIENT_URL}`);
    console.log(`   Backend:  http://localhost:${PORT}`);
    console.log(`   Health:   http://localhost:${PORT}/health\n`);
  }
});