// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins
  },
});

// Object to store online users: { userId: [socketId, ...] }
let onlineUsers = {};

// Helper to broadcast the current online users list
const emitOnlineUsers = () => {
  io.emit("online_users", Object.keys(onlineUsers));
};

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Allow a client to request the current list on-demand
  socket.on("get_online_users", () => {
    socket.emit("online_users", Object.keys(onlineUsers));
  });

  // Mark a user online
  const markUserOnline = (userId) => {
    if (!onlineUsers[userId]) {
      onlineUsers[userId] = [];
    }
    if (!onlineUsers[userId].includes(socket.id)) {
      onlineUsers[userId].push(socket.id);
    }
    io.emit("user_online", { userId });
    emitOnlineUsers();
    console.log(`User ${userId} is online with sockets:`, onlineUsers[userId]);
  };

  socket.on("presence_online", ({ userId }) => {
    markUserOnline(userId);
  });

  socket.on("join_room", ({ chatRoomId, userId }) => {
    socket.join(chatRoomId);
    markUserOnline(userId);
    console.log(`User ${userId} joined room ${chatRoomId}`);
  });

  socket.on("send_message", (messageData) => {
    console.log("📨 New Message:", messageData);
    io.to(messageData.chatRoomId).emit("receive_message", messageData);
  });

  socket.on("typing", ({ chatRoomId, userId }) => {
    socket.to(chatRoomId).emit("user_typing", { userId });
  });

  socket.on("stop_typing", ({ chatRoomId, userId }) => {
    socket.to(chatRoomId).emit("user_stopped_typing", { userId });
  });

  socket.on("message_seen", (data) => {
    const { chatRoomId, userId, messageId } = data;
    
    console.log(`🔍 Message seen by ${userId} in room ${chatRoomId}: message ${messageId}`);
    
    // IMPORTANT: Broadcast to ALL clients in the room, including the sender
    io.to(chatRoomId).emit("user_see_message", { 
      userId, 
      messageId,
      chatRoomId,
      timestamp: Date.now() // Add timestamp for instant updates
    });
    
    // Also store this in the database for persistence
    // This is where you'd update the message's readBy array in your database
  });

  socket.on("disconnect", () => {
    for (const userId in onlineUsers) {
      onlineUsers[userId] = onlineUsers[userId].filter((id) => id !== socket.id);
      if (onlineUsers[userId].length === 0) {
        delete onlineUsers[userId];
        io.emit("user_offline", { userId });
        console.log(`User ${userId} is now offline.`);
      }
    }
    emitOnlineUsers();
    console.log("❌ Socket disconnected:", socket.id);
    console.log("🟢 Online Users:", onlineUsers);
  });
});

server.listen(3001, () => {
  console.log("🚀 Socket server running on port 3001");
});
