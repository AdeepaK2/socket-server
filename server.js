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
  MEETING_PARTICIPANTS: (meetingId) => `meeting_participants:${meetingId}`,
  MEETING_TRANSCRIPTS: (meetingId) => `meeting_transcripts:${meetingId}`,
  MEETING_CHAT: (meetingId) => `meeting_chat:${meetingId}`,
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
    
    // Also update database for persistence
    await updateDeliveryStatusInDatabase(messageId, status);
  } catch (error) {
    console.error('Error tracking message delivery:', error);
  }
};

// Function to update delivery status in MongoDB database
const updateDeliveryStatusInDatabase = async (messageId, deliveryStatus) => {
  try {
    const response = await fetch('http://localhost:3001/api/messages/delivery-status', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-system-api-key': process.env.SYSTEM_API_KEY || 'XhgL7Pkz5vBYtRQj2DAm9cEq3UF8TnW4ZsV6HdxfKCNr1pGya0JuLiMo4eS5wbP2'
      },
      body: JSON.stringify({
        messageId,
        deliveryStatus
      })
    });

    if (response.ok) {
      console.log(`Database updated: Message ${messageId} status -> ${deliveryStatus}`);
    } else {
      console.error('Failed to update database delivery status:', await response.text());
    }
  } catch (error) {
    console.error('Error updating database delivery status:', error);
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

// Meeting-specific helper functions
const addMeetingParticipant = async (meetingId, userId, socketId) => {
  try {
    const participantKey = REDIS_KEYS.MEETING_PARTICIPANTS(meetingId);
    await redis.hSet(participantKey, userId, JSON.stringify({
      socketId,
      joinedAt: Date.now(),
      status: 'active'
    }));
    await redis.expire(participantKey, 24 * 60 * 60); // 24 hours expiry
  } catch (error) {
    console.error('Error adding meeting participant:', error);
  }
};

const removeMeetingParticipant = async (meetingId, userId) => {
  try {
    const participantKey = REDIS_KEYS.MEETING_PARTICIPANTS(meetingId);
    await redis.hDel(participantKey, userId);
  } catch (error) {
    console.error('Error removing meeting participant:', error);
  }
};

const getMeetingParticipants = async (meetingId) => {
  try {
    const participantKey = REDIS_KEYS.MEETING_PARTICIPANTS(meetingId);
    const participants = await redis.hGetAll(participantKey);
    return Object.keys(participants).map(userId => ({
      userId,
      ...JSON.parse(participants[userId])
    }));
  } catch (error) {
    console.error('Error getting meeting participants:', error);
    return [];
  }
};

const saveMeetingTranscriptSegment = async (meetingId, segment) => {
  try {
    const transcriptKey = REDIS_KEYS.MEETING_TRANSCRIPTS(meetingId);
    await redis.lPush(transcriptKey, JSON.stringify(segment));
    await redis.expire(transcriptKey, 7 * 24 * 60 * 60); // 7 days expiry
  } catch (error) {
    console.error('Error saving transcript segment:', error);
  }
};

const saveMeetingChatMessage = async (meetingId, message) => {
  try {
    const chatKey = REDIS_KEYS.MEETING_CHAT(meetingId);
    await redis.lPush(chatKey, JSON.stringify(message));
    await redis.expire(chatKey, 7 * 24 * 60 * 60); // 7 days expiry
  } catch (error) {
    console.error('Error saving meeting chat message:', error);
  }
};

// ! notification
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
 *! Meeting rooms tracking
 * @type {Object.<string, Set<string>>}
 * @description Maps meeting IDs to sets of socket IDs
 */
let meetingRooms = {};

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
   *! Meeting-specific room joining
   * @event join_meeting_chat
   * @description Joins a meeting-specific chat room
   */
  socket.on("join_meeting_chat", async ({ meetingId, userId }) => {
    const meetingRoom = `meeting_chat_${meetingId}`;
    socket.join(meetingRoom);
    
    // Track meeting participant
    await addMeetingParticipant(meetingId, userId, socket.id);
    
    // Initialize meeting room tracking
    if (!meetingRooms[meetingId]) {
      meetingRooms[meetingId] = new Set();
    }
    meetingRooms[meetingId].add(socket.id);
    
    console.log(`User ${userId} joined meeting chat ${meetingId}`);
    
    // Send system message to meeting participants
    const systemMessage = {
      id: Date.now().toString(),
      senderId: 'system',
      senderName: 'System',
      message: `User joined the meeting`,
      timestamp: new Date(),
      type: 'system'
    };
    
    socket.to(meetingRoom).emit('meeting_system_message', {
      meetingId,
      message: systemMessage
    });
  });

  /**
   *! Join meeting room for video/audio connection
   * @event join_meeting_room
   * @description Joins the main meeting room for video/audio coordination
   */
  socket.on("join_meeting_room", async ({ meetingId, userId, userInfo }) => {
    const meetingRoom = `meeting_${meetingId}`;
    socket.join(meetingRoom);
    
    // Track meeting participant
    await addMeetingParticipant(meetingId, userId, socket.id);
    
    // Initialize meeting room tracking
    if (!meetingRooms[meetingId]) {
      meetingRooms[meetingId] = new Set();
    }
    meetingRooms[meetingId].add(socket.id);
    
    console.log(`User ${userId} joined meeting room ${meetingId}`);
    
    // Notify other participants about user joining
    socket.to(meetingRoom).emit('user_joined_meeting', {
      userId,
      userInfo,
      socketId: socket.id,
      timestamp: Date.now()
    });
    
    // Send current participants list to the new user
    const participants = await getMeetingParticipants(meetingId);
    socket.emit('meeting_participants_list', {
      meetingId,
      participants: participants.filter(p => p.userId !== userId)
    });
  });

  /**
   *! Leave meeting room
   * @event leave_meeting_room
   * @description Leaves the main meeting room
   */
  socket.on("leave_meeting_room", async ({ meetingId, userId }) => {
    const meetingRoom = `meeting_${meetingId}`;
    socket.leave(meetingRoom);
    
    // Remove from meeting participant tracking
    await removeMeetingParticipant(meetingId, userId);
    
    // Remove from meeting room tracking
    if (meetingRooms[meetingId]) {
      meetingRooms[meetingId].delete(socket.id);
      if (meetingRooms[meetingId].size === 0) {
        delete meetingRooms[meetingId];
      }
    }
    
    console.log(`User ${userId} left meeting room ${meetingId}`);
    
    // Notify other participants about user leaving
    socket.to(meetingRoom).emit('user_left_meeting', {
      userId,
      timestamp: Date.now()
    });
  });

  /**
   *! WebRTC signaling for peer-to-peer connection
   * @event webrtc_offer
   * @description Sends WebRTC offer to specific user
   */
  socket.on("webrtc_offer", ({ meetingId, targetUserId, offer, offerUserId }) => {
    const meetingRoom = `meeting_${meetingId}`;
    // Send offer to specific user in the meeting
    socket.to(meetingRoom).emit('webrtc_offer_received', {
      meetingId,
      offer,
      offerUserId,
      targetUserId
    });
  });

  /**
   *! WebRTC answer
   * @event webrtc_answer
   * @description Sends WebRTC answer to specific user
   */
  socket.on("webrtc_answer", ({ meetingId, targetUserId, answer, answerUserId }) => {
    const meetingRoom = `meeting_${meetingId}`;
    socket.to(meetingRoom).emit('webrtc_answer_received', {
      meetingId,
      answer,
      answerUserId,
      targetUserId
    });
  });

  /**
   *! WebRTC ICE candidate
   * @event webrtc_ice_candidate
   * @description Sends ICE candidate to specific user
   */
  socket.on("webrtc_ice_candidate", ({ meetingId, targetUserId, candidate, candidateUserId }) => {
    const meetingRoom = `meeting_${meetingId}`;
    socket.to(meetingRoom).emit('webrtc_ice_candidate_received', {
      meetingId,
      candidate,
      candidateUserId,
      targetUserId
    });
  });

  /**
   *! Media state changes (mute/unmute, video on/off)
   * @event media_state_change
   * @description Broadcasts media state changes to other participants
   */
  socket.on("media_state_change", ({ meetingId, userId, mediaState }) => {
    const meetingRoom = `meeting_${meetingId}`;
    socket.to(meetingRoom).emit('participant_media_state_changed', {
      meetingId,
      userId,
      mediaState,
      timestamp: Date.now()
    });
  });

  /**
   *! Handle meeting chat messages
   * @event meeting_chat_message
   * @description Broadcasts chat message to meeting participants
   */
  socket.on("meeting_chat_message", async (data) => {
    const { meetingId, message } = data;
    const meetingRoom = `meeting_chat_${meetingId}`;
    
    console.log(`Meeting chat message in ${meetingId}:`, message);
    
    // Save message to Redis for persistence
    await saveMeetingChatMessage(meetingId, message);
    
    // Broadcast to all meeting participants
    socket.to(meetingRoom).emit('meeting_chat_message', {
      meetingId,
      message
    });
  });

  /**
   *! Handle meeting transcription segments
   * @event meeting_transcription_segment
   * @description Broadcasts transcription segment to meeting participants
   */
  socket.on("meeting_transcription_segment", async (data) => {
    const { meetingId, segment } = data;
    const meetingRoom = `meeting_transcription_${meetingId}`;
    
    console.log(`Transcription segment in meeting ${meetingId}:`, segment);
    
    // Save transcript segment to Redis
    await saveMeetingTranscriptSegment(meetingId, segment);
    
    // Broadcast to all meeting participants
    socket.to(meetingRoom).emit('meeting_transcription_segment', {
      meetingId,
      segment
    });
    
    // Also save to database for long-term storage
    try {
      await fetch('http://localhost:3001/api/meeting/transcription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-system-api-key': process.env.SYSTEM_API_KEY || 'XhgL7Pkz5vBYtRQj2DAm9cEq3UF8TnW4ZsV6HdxfKCNr1pGya0JuLiMo4eS5wbP2'
        },
        body: JSON.stringify({
          meetingId,
          segments: [segment],
          timestamp: Date.now()
        })
      });
    } catch (error) {
      console.error('Error saving transcription to database:', error);
    }
  });

  /**
   *! Join meeting transcription room
   * @event join_meeting_transcription
   * @description Joins meeting transcription room for real-time updates
   */
  socket.on("join_meeting_transcription", ({ meetingId, userId }) => {
    const transcriptionRoom = `meeting_transcription_${meetingId}`;
    socket.join(transcriptionRoom);
    console.log(`User ${userId} joined meeting transcription ${meetingId}`);
  });

  /**
   *! Handle meeting status updates
   * @event meeting_status_update
   * @description Broadcasts meeting status changes (started, ended, etc.)
   */
  socket.on("meeting_status_update", async (data) => {
    const { meetingId, status, userId } = data;
    const meetingRoom = `meeting_${meetingId}`;
    
    console.log(`Meeting ${meetingId} status update: ${status} by user ${userId}`);
    
    // Broadcast status update to all meeting participants
    io.to(meetingRoom).emit('meeting_status_update', {
      meetingId,
      status,
      updatedBy: userId,
      timestamp: Date.now()
    });
  });

  /**
   *! Handle meeting recording controls
   * @event meeting_recording_control
   * @description Broadcasts recording start/stop events
   */
  socket.on("meeting_recording_control", async (data) => {
    const { meetingId, action, userId } = data; // action: 'start' or 'stop'
    const meetingRoom = `meeting_${meetingId}`;
    
    console.log(`Meeting ${meetingId} recording ${action} by user ${userId}`);
    
    // Broadcast recording status to all meeting participants
    socket.to(meetingRoom).emit('meeting_recording_status', {
      meetingId,
      isRecording: action === 'start',
      updatedBy: userId,
      timestamp: Date.now()
    });
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
      await redis.sAdd(REDIS_KEYS.READ_RECEIPTS(messageId), readerId);

      // Notify sender about read status
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
   * @event check_delivery_status
   * @description Check and update delivery status for pending messages
   */
  socket.on("check_delivery_status", async (data) => {
    const { messageId, chatRoomId, senderId } = data;
    console.log(`Checking delivery status for message ${messageId}`);

    try {
      // Get current delivery status from Redis
      const deliveryKey = REDIS_KEYS.MESSAGE_DELIVERY(messageId);
      const currentStatus = await redis.hGet(deliveryKey, 'status');
      
      if (currentStatus === MessageDeliveryStatus.SENT) {
        // Check if recipient is online (this would require knowing the recipient)
        // For now, we'll mark as delivered if someone is checking
        await trackMessageDelivery(messageId, senderId, MessageDeliveryStatus.DELIVERED);
        
        // Emit delivery update to the chat room
        io.to(chatRoomId).emit("message_delivery_update", {
          messageId,
          deliveryStatus: MessageDeliveryStatus.DELIVERED,
          chatRoomId,
          deliveredAt: Date.now()
        });
      }
    } catch (error) {
      console.error('Error checking delivery status:', error);
    }
  });

  /**
   * @event user_came_online
   * @description Handle when a user comes online and update delivery status of their pending messages
   */
  socket.on("user_came_online", async (data) => {
    const { userId } = data;
    console.log(`User ${userId} came online, processing pending messages`);

    try {
      // Process undelivered messages for this user
      await processUndeliveredMessages(userId);
    } catch (error) {
      console.error('Error processing user came online:', error);
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
    let disconnectedUserId = null;
    
    // Scan all users to find and remove this specific socket ID
    for (const userId in onlineUsers) {
      // Remove this socket from the user's connections array
      onlineUsers[userId] = onlineUsers[userId].filter((id) => id !== socket.id);
      
      // If user has no remaining connections, they're fully offline
      if (onlineUsers[userId].length === 0) {
        disconnectedUserId = userId;
        delete onlineUsers[userId];
        
        // Update Redis with offline status
        await markUserOfflineInRedis(userId);
        
        io.emit("user_offline", { userId });
        console.log(`User ${userId} is now offline.`);
      }
    }
    
    // Clean up meeting room tracking and notify participants
    for (const meetingId in meetingRooms) {
      if (meetingRooms[meetingId].has(socket.id)) {
        meetingRooms[meetingId].delete(socket.id);
        
        // Remove from Redis tracking
        if (disconnectedUserId) {
          await removeMeetingParticipant(meetingId, disconnectedUserId);
          
          // Notify other participants
          socket.to(`meeting_${meetingId}`).emit('user_left_meeting', {
            userId: disconnectedUserId,
            timestamp: Date.now()
          });
        }
        
        // Clean up empty meeting rooms
        if (meetingRooms[meetingId].size === 0) {
          delete meetingRooms[meetingId];
        }
      }
    }
    
    // Update everyone with the revised online users list
    emitOnlineUsers();
    
    console.log("Socket disconnected:", socket.id);
    if (disconnectedUserId) {
      console.log("User disconnected from meetings:", disconnectedUserId);
    }
    console.log("Online Users:", onlineUsers);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Socket server running on port ${PORT}`);
  console.log(`📱 Meeting features enabled`);
  console.log(`🎙️ Real-time transcription supported`);
  console.log(`💬 Meeting chat supported`);
});
