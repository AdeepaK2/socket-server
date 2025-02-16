const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for development
  },
});

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Handle when a user joins a chat room
  socket.on("join_room", (chatRoomId) => {
    socket.join(chatRoomId);
    console.log(`User ${socket.id} joined room ${chatRoomId}`);
  });

  // Handle sending messages in real time
  socket.on("send_message", (messageData) => {
    console.log("📨 New Message:", messageData);

    // Broadcast message to the same chat room
    io.to(messageData.chatRoomId).emit("receive_message", messageData);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

server.listen(3001, () => {
  console.log("🚀 Socket server running on port 3001");
});
