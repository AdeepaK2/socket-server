require('dotenv').config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);

// Redis client setup - Cloud Configuration
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Initialize Redis connection
(async () => {
  try {
    await redis.connect();
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
  }
})();

// Redis keys
const REDIS_KEYS = {
  ONLINE_USERS: 'online_users',
  MESSAGE_DELIVERY: (messageId) => `message_delivery:${messageId}`,
  USER_LAST_SEEN: (userId) => `user_last_seen:${userId}`,
  UNDELIVERED_MESSAGES: (userId) => `undelivered:${userId}`,
  READ_RECEIPTS: (messageId) => `read_receipts:${messageId}`,
};

// Message delivery status helper functions
const MessageDeliveryStatus = {
  SENT: 'sent',
  DELIVERED: 'delivered', 
  READ: 'read'
};

const trackMessageDelivery = async (messageId, recipientId, status, timestamp = Date.now()) => {
  try {
    const deliveryKey = REDIS_KEYS.MESSAGE_DELIVERY(messageId);
    
    const deliveryData = {
      messageId,
      recipientId,
      status,
      [`${status}At`]: timestamp.toString()
    };

    await redis.hSet(deliveryKey, deliveryData);
    await redis.expire(deliveryKey, 30 * 24 * 60 * 60); // 30 days expiry
  } catch (error) {
    console.error('Error tracking message delivery:', error);
  }
};

const isUserOnline = async (userId) => {
  try {
    return await redis.sIsMember(REDIS_KEYS.ONLINE_USERS, userId);
  } catch (error) {
    console.error('Error checking user online status:', error);
    return false;
  }
};

const markUserOnlineInRedis = async (userId, socketId = '') => {
  try {
    await Promise.all([
      redis.sAdd(REDIS_KEYS.ONLINE_USERS, userId),
      redis.hSet(REDIS_KEYS.USER_LAST_SEEN(userId), {
        timestamp: Date.now(),
        socketId,
        status: 'online'
      })
    ]);
  } catch (error) {
    console.error('Error marking user online in Redis:', error);
  }
};

const markUserOfflineInRedis = async (userId) => {
  try {
    await Promise.all([
      redis.sRem(REDIS_KEYS.ONLINE_USERS, userId),
      redis.hSet(REDIS_KEYS.USER_LAST_SEEN(userId), {
        timestamp: Date.now(),
        status: 'offline'
      })
    ]);
  } catch (error) {
    console.error('Error marking user offline in Redis:', error);
  }
};

const addToUndeliveredQueue = async (userId, messageId) => {
  try {
    await redis.lPush(REDIS_KEYS.UNDELIVERED_MESSAGES(userId), messageId);
    await redis.expire(REDIS_KEYS.UNDELIVERED_MESSAGES(userId), 7 * 24 * 60 * 60); // 7 days
  } catch (error) {
    console.error('Error adding to undelivered queue:', error);
  }
};

const processUndeliveredMessages = async (userId) => {
  try {
    const undeliveredKey = REDIS_KEYS.UNDELIVERED_MESSAGES(userId);
    const messageIds = await redis.lRange(undeliveredKey, 0, -1);
    
    if (messageIds.length > 0) {
      // Mark all undelivered messages as delivered
      for (const messageId of messageIds) {
        await trackMessageDelivery(messageId, userId, MessageDeliveryStatus.DELIVERED);
          // Emit delivery status update to sender
        const senderSockets = onlineUsers[messageId.split('_')[0]]; // Assuming messageId format includes senderId
        if (senderSockets) {
          senderSockets.forEach(socketId => {
            io.to(socketId).emit("message_delivery_update", {
              messageId,
              deliveryStatus: MessageDeliveryStatus.DELIVERED,
              deliveredAt: Date.now()
            });
          });
        }
      }
      
      // Clear the undelivered queue
      await redis.del(undeliveredKey);
      console.log(`Processed ${messageIds.length} undelivered messages for user ${userId}`);
    }
  } catch (error) {
    console.error('Error processing undelivered messages:', error);
  }
};

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
  const markUserOnline = async (userId) => {
    // Initialize user's socket array if this is their first connection
    if (!onlineUsers[userId]) {
      onlineUsers[userId] = [];
    }
    
    // Prevent duplicate socket entries for the same user
    if (!onlineUsers[userId].includes(socket.id)) {
      onlineUsers[userId].push(socket.id);
    }
    
    // Update Redis with user online status
    await markUserOnlineInRedis(userId, socket.id);
    
    // Broadcast presence update to all clients
    io.emit("user_online", { userId });
    emitOnlineUsers();
    
    console.log(`User ${userId} is online with sockets:`, onlineUsers[userId]);
    
    // Process any undelivered messages for this user
    await processUndeliveredMessages(userId);
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
   * @description Broadcasts the message to all clients in the specified room and tracks delivery
   */
  socket.on("send_message", async (messageData) => {
    console.log("📨 New Message:", messageData);
    
    try {
      // Broadcast message to room
      io.to(messageData.chatRoomId).emit("receive_message", messageData);
      
      // Track delivery status based on recipient online status
      if (messageData.recipientId && messageData._id) {
        const recipientOnline = await isUserOnline(messageData.recipientId);
          if (recipientOnline) {
          // Recipient is online - mark as delivered
          await trackMessageDelivery(messageData._id, messageData.recipientId, MessageDeliveryStatus.DELIVERED);
          
          // Emit delivery confirmation back to sender
          socket.emit("message_delivery_update", {
            messageId: messageData._id,
            deliveryStatus: MessageDeliveryStatus.DELIVERED,
            chatRoomId: messageData.chatRoomId,
            deliveredAt: Date.now()
          });
        } else {
          // Recipient is offline - mark as sent and add to undelivered queue
          await trackMessageDelivery(messageData._id, messageData.recipientId, MessageDeliveryStatus.SENT);
          await addToUndeliveredQueue(messageData.recipientId, messageData._id);
          
          // Emit sent confirmation back to sender
          socket.emit("message_delivery_update", {
            messageId: messageData._id,
            deliveryStatus: MessageDeliveryStatus.SENT,
            chatRoomId: messageData.chatRoomId,
            sentAt: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('Error processing message delivery:', error);
    }
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
    console.log(`User ${userId} stopped typing in chat room ${chatRoomId}`);
  });

  /**
   *! Handles message delivery confirmation
   * @event message_delivered  
   * @description Updates delivery status when message is viewed by recipient
   */
  socket.on("message_delivered", async (data) => {
    const { messageId, chatRoomId, userId } = data;
    console.log(`Message ${messageId} delivered to user ${userId} in chatroom ${chatRoomId}`);

    try {
      // Track delivery status in Redis
      await trackMessageDelivery(messageId, userId, MessageDeliveryStatus.DELIVERED);

      // Emit delivery update to the chat room
      io.to(chatRoomId).emit("message_delivery_update", {
        messageId,
        deliveryStatus: MessageDeliveryStatus.DELIVERED,
        chatRoomId,
        deliveredAt: Date.now()
      });

      console.log(`Message delivery status updated for message ${messageId}`);
    } catch (error) {
      console.error('Error processing message delivery:', error);
    }
  });

  /**
   *! Handles Message Read
   *  @event message_read
   *  @description Tracks read status and notifies sender
   */
  socket.on("message_read", async (data) => {
    const { messageId, chatRoomId, readerId, senderId } = data;
    console.log(`Message ${messageId} is read by ${readerId} in chatroom ${chatRoomId}`);

    try {
      // Track read status in Redis
      await trackMessageDelivery(messageId, readerId, MessageDeliveryStatus.READ);
      await redis.sAdd(REDIS_KEYS.READ_RECEIPTS(messageId), readerId);      // Notify sender about read status
      const senderSockets = onlineUsers[senderId];
      if (senderSockets) {
        senderSockets.forEach(socketId => {
          io.to(socketId).emit("message_delivery_update", {
            messageId,
            deliveryStatus: MessageDeliveryStatus.READ,
            chatRoomId,
            readAt: Date.now()
          });
        });
      }

      // Emit to chat room for UI updates
      io.to(chatRoomId).emit("message_delivery_update", {
        messageId,
        deliveryStatus: MessageDeliveryStatus.READ,
        chatRoomId,
        readAt: Date.now()
      });
    } catch (error) {
      console.error('Error tracking message read status:', error);
    }
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
   *  @description Updates presence tracking and Redis when user disconnects
   */
  socket.on("disconnect", async () => {
    // Scan all users to find and remove this specific socket ID
    for (const userId in onlineUsers) {
      // Remove this socket from the user's connections array
      onlineUsers[userId] = onlineUsers[userId].filter((id) => id !== socket.id);
      
      // If user has no remaining connections, they're fully offline
      if (onlineUsers[userId].length === 0) {
        delete onlineUsers[userId];
        
        // Update Redis with offline status
        await markUserOfflineInRedis(userId);
        
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

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Socket server running on port ${PORT}`);
});
