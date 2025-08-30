const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);

// Configure CORS
app.use(cors({
  origin: "http://localhost:5173", // Vite dev server default port
  credentials: true
}));

// Socket.io setup with CORS
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Store room information
const rooms = new Map();
const socketToRoom = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle room joining
  socket.on('room:join', ({ roomId }) => {
    console.log(`User ${socket.id} joining room ${roomId}`);
    
    // Leave any existing room
    const currentRoom = socketToRoom.get(socket.id);
    if (currentRoom) {
      socket.leave(currentRoom);
      const room = rooms.get(currentRoom);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(currentRoom);
        } else {
          // Notify other users in the room that this user left
          socket.to(currentRoom).emit('user:left', { socketId: socket.id });
        }
      }
      socketToRoom.delete(socket.id);
    }

    // Join new room
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    
    const room = rooms.get(roomId);
    room.add(socket.id);

    // If there's already someone in the room, notify both users
    const otherUsers = Array.from(room).filter(id => id !== socket.id);
    if (otherUsers.length > 0) {
      // Notify the new user about existing user
      socket.emit('user:joined', { 
        socketId: otherUsers[0], 
        roomId 
      });
      
      // Notify existing user about new user
      socket.to(otherUsers[0]).emit('user:joined', { 
        socketId: socket.id, 
        roomId 
      });
    }

    console.log(`Room ${roomId} now has ${room.size} users`);
  });

  // Handle outgoing call
  socket.on('outgoing:call', ({ to, offer }) => {
    console.log(`Call from ${socket.id} to ${to}`);
    socket.to(to).emit('incoming:call', { 
      from: socket.id, 
      offer 
    });
  });

  // Handle call accepted
  socket.on('call:accepted', ({ to, answer }) => {
    console.log(`Call accepted by ${socket.id} to ${to}`);
    socket.to(to).emit('call:accepted', { 
      from: socket.id, 
      answer 
    });
  });

  // Handle ICE candidates
  socket.on('ice:candidate', ({ candidate, to }) => {
    socket.to(to).emit('ice:candidate', { 
      candidate, 
      from: socket.id 
    });
  });

  // Handle call ended
  socket.on('call:ended', ({ to }) => {
    console.log(`Call ended by ${socket.id}`);
    socket.to(to).emit('call:ended', { from: socket.id });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.delete(socket.id);
        
        // Notify other users in the room
        socket.to(roomId).emit('user:left', { socketId: socket.id });
        
        if (room.size === 0) {
          rooms.delete(roomId);
          console.log(`Room ${roomId} deleted`);
        } else {
          console.log(`Room ${roomId} now has ${room.size} users`);
        }
      }
      socketToRoom.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.io server ready for connections`);
});