const express = require("express");
const http = require("http");
const { Server } = require("socket.io");


const app = express();
const server = http.createServer(app);

// ! norification
app.use(express.json());

app.post('/emit-notification', (req, res) => {
  try {
    const notificationData = req.body;
    console.log("API triggered notification:", notificationData);
    
    if (notificationData.broadcast) {
      // Broadcast to all connected clients
      io.emit("receive_notification", notificationData);
      console.log("Broadcasting notification to all users");
    } else if (notificationData.userId) {
      // Send to specific user's sockets
      const userSockets = onlineUsers[notificationData.userId];
      
      if (userSockets && userSockets.length > 0) {
        userSockets.forEach(socketId => {
          io.to(socketId).emit("receive_notification", notificationData);
        });
        console.log(`Notification sent to user ${notificationData.userId}`);
      } else {
        console.log(`User ${notificationData.userId} is offline, notification saved but not delivered`);
      }
    }
    
    res.status(200).json({ success: true, message: 'Notification emitted' });
  } catch (error) {
    console.error('Error processing notification:', error);
    res.status(500).json({ success: false, message: 'Error emitting notification' });
  }
});

/**
 * ! Socket.IO server instance with CORS configuration
 * @note In production change to respective domain
 */
const io = new Server(server, {
  cors: {
    origin: "*", // TODO: Restrict to  domains in production
  },
});

/** 
 *! User presence tracking data structure
 *  @type {Object.<string, Array<string>>}
 *  @description Maps user IDs to arrays of socket IDs
 *  This allows a single user to be connected from multiple devices/browsers
 *  A user is considered online if they have at least one active socket connection
 */
let onlineUsers = {};

/**
 *! Broadcasts the current list of online users to all connected clients
 *  @function emitOnlineUsers
 *  @description Sends only the user IDs (not socket details) for privacy and efficiency
 */
const emitOnlineUsers = () => {
  io.emit("online_users", Object.keys(onlineUsers));
};

//  Socket Connection Handler 
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  /**
   * Handles requests for the current online users list
   * @event get_online_users
   * @description Responds only to the requesting client
   */
  socket.on("get_online_users", () => {
    socket.emit("online_users", Object.keys(onlineUsers));
  });

  /**
   * Registers a user as online with the current socket
   * @function markUserOnline
   * @param {string} userId - The unique identifier of the user
   * @description Updates presence tracking and notifies all clients
   */
  const markUserOnline = (userId) => {
    // Initialize user's socket array if this is their first connection
    if (!onlineUsers[userId]) {
      onlineUsers[userId] = [];
    }
    
    // Prevent duplicate socket entries for the same user
    if (!onlineUsers[userId].includes(socket.id)) {
      onlineUsers[userId].push(socket.id);
    }
    
    // Broadcast presence update to all clients
    io.emit("user_online", { userId });
    emitOnlineUsers();
    
    console.log(`User ${userId} is online with sockets:`, onlineUsers[userId]);
  };

  /**
   *! Handles explicit user presence 
   *  @event presence_online
   *  @description Called when user logs in or explicitly sets their status as online
   */
  socket.on("presence_online", ({ userId }) => {
    markUserOnline(userId);
  });

  /**
   *! Handles room join requests and tracks user presence
   * @event join_room
   * @description Adds the socket to a specific chat room and updates presence
   */
  socket.on("join_room", ({ chatRoomId, userId }) => {
    socket.join(chatRoomId);
    markUserOnline(userId);
    console.log(`User ${userId} joined room ${chatRoomId}`);
  });

  /**
   *! Processes new chat messages
   * @event send_message
   * @description Broadcasts the message to all clients in the specified room
   */
  socket.on("send_message", (messageData) => {
    console.log("📨 New Message:", messageData);
    io.to(messageData.chatRoomId).emit("receive_message", messageData);
  });

 
  /**
   *! Handles typing indicator start events
   *  @event typing
   *  @description Notifies other room members that a user is typing
   */
  socket.on("typing", ({ chatRoomId, userId }) => {
    socket.to(chatRoomId).emit("user_typing", { userId, chatRoomId });
    console.log(`User ${userId} is typing in chat room ${chatRoomId}`);
  });

  /**
   *! Handles typing indicator stop events
   * @event stop_typing
   * @description Notifies other room members that a user stopped typing
   */
  socket.on("stop_typing", ({ chatRoomId, userId }) => {
    socket.to(chatRoomId).emit("user_stopped_typing", { userId, chatRoomId });
    console.log(`User ${userId} is stop typing in chat room ${chatRoomId}`);
  });
  /**
   *! Handles Message Read
   *  @event message_read
   *  @description Cleans up presence data and notifies other users
   * A user is only marked offline when all their socket connections are closed
   */
  socket.on("message_read",(data)=>{
    const {messageId,chatRoomId,readerId,senderId}= data;
    console.log(` Message ${messageId} is read by ${readerId} in chatroom ${chatRoomId}`);

    io.to(chatRoomId).emit("message_seen",{
      messageId,
      readerId,
      senderId,
    });
  });

  /**
   * Handle notification broadcast or direct user notifications
   * @event notification
   * @description Broadcasts notification to specific user(s) or all connected clients
   */
  socket.on("notification", (notificationData) => {
    console.log("New Notification:", notificationData);
    
    if (notificationData.broadcast) {
      // Broadcast to all connected clients
      io.emit("receive_notification", notificationData);
      console.log("Broadcasting notification to all users");
    } else if (notificationData.userId) {
      // Send to specific user's sockets
      const userSockets = onlineUsers[notificationData.userId];
      
      if (userSockets && userSockets.length > 0) {
        userSockets.forEach(socketId => {
          io.to(socketId).emit("receive_notification", notificationData);
        });
        console.log(`Notification sent to user ${notificationData.userId}`);
      } else {
        console.log(`User ${notificationData.userId} is offline, notification saved but not delivered`);
      }
    }
  });

 
  /**
   *! Handles socket disconnections
   *  @event disconnect
   *  @description 
   */
  socket.on("disconnect", () => {
    // Scan all users to find and remove this specific socket ID
    for (const userId in onlineUsers) {
      // Remove this socket from the user's connections array
      onlineUsers[userId] = onlineUsers[userId].filter((id) => id !== socket.id);
      
      // If user has no remaining connections, they're fully offline
      if (onlineUsers[userId].length === 0) {
        delete onlineUsers[userId];
        io.emit("user_offline", { userId });
        console.log(`User ${userId} is now offline.`);
      }
    }
    
    // Update everyone with the revised online users list
    emitOnlineUsers();
    
    console.log("Socket disconnected:", socket.id);
    console.log("Online Users:", onlineUsers);
  });
});

server.listen(3001, () => {
  console.log("🚀 Socket server running on port 3001");
});