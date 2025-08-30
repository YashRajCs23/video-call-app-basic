import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, Copy, Users, AlertCircle, Wifi, WifiOff } from 'lucide-react';
import io from 'socket.io-client';

const VideoCallApp = () => {
  const [socket, setSocket] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isInCall, setIsInCall] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [myStream, setMyStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [connectionState, setConnectionState] = useState('new');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [roomJoined, setRoomJoined] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);

  // WebRTC configuration with multiple STUN servers
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.stunprotocol.org:3478' }
    ],
    iceCandidatePoolSize: 10
  };

  // Clear error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // Initialize socket connection
  useEffect(() => {
    const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
    const newSocket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      forceNew: true
    });
    
    setSocket(newSocket);
    socketRef.current = newSocket;

    // Connection event handlers
    newSocket.on('connect', () => {
      setIsConnected(true);
      setError('');
      console.log('Connected to server:', newSocket.id);
    });

    newSocket.on('disconnect', (reason) => {
      setIsConnected(false);
      setError(`Disconnected: ${reason}`);
      console.log('Disconnected:', reason);
    });

    newSocket.on('connect_error', (err) => {
      setIsConnected(false);
      setError(`Connection failed: ${err.message}`);
      console.error('Connection error:', err);
    });

    // Room event handlers
    newSocket.on('user:joined', ({ socketId, roomId: joinedRoomId }) => {
      console.log('User joined:', socketId);
      setRemoteSocketId(socketId);
    });

    newSocket.on('user:left', ({ socketId }) => {
      console.log('User left:', socketId);
      setRemoteSocketId(null);
      setRemoteStream(null);
      cleanupCall();
    });

    // Call event handlers
    newSocket.on('incoming:call', handleIncomingCall);
    newSocket.on('call:accepted', handleCallAccepted);
    newSocket.on('call:ended', cleanupCall);
    newSocket.on('ice:candidate', handleIceCandidate);

    return () => {
      cleanupResources();
      newSocket.close();
    };
  }, []);

  // Cleanup function
  const cleanupResources = useCallback(() => {
    if (myStream) {
      myStream.getTracks().forEach(track => {
        track.stop();
      });
      setMyStream(null);
    }
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    setRemoteStream(null);
    setIsInCall(false);
    setConnectionState('new');
  }, [myStream]);

  // Create peer connection with enhanced error handling
  const createPeerConnection = useCallback(() => {
    try {
      const pc = new RTCPeerConnection(configuration);

      // Connection state monitoring
      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState);
        console.log('Connection state:', pc.connectionState);
        
        if (pc.connectionState === 'failed') {
          setError('Connection failed. Please try again.');
          cleanupCall();
        }
      };

      // ICE candidate handling
      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current && remoteSocketId) {
          socketRef.current.emit('ice:candidate', {
            candidate: event.candidate,
            to: remoteSocketId
          });
        }
      };

      // Remote stream handling
      pc.ontrack = (event) => {
        console.log('Received remote stream');
        setRemoteStream(event.streams[0]);
      };

      // ICE connection state
      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
      };

      return pc;
    } catch (err) {
      console.error('Failed to create peer connection:', err);
      setError('Failed to create peer connection');
      return null;
    }
  }, [remoteSocketId]);

  // Get user media with better error handling
  const getUserMedia = useCallback(async (constraints = { video: true, audio: true }) => {
    try {
      setIsLoading(true);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setMyStream(stream);
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      setError('');
      return stream;
    } catch (err) {
      console.error('Error accessing media devices:', err);
      let errorMessage = 'Failed to access camera/microphone. ';
      
      if (err.name === 'NotAllowedError') {
        errorMessage += 'Please allow camera and microphone permissions.';
      } else if (err.name === 'NotFoundError') {
        errorMessage += 'No camera or microphone found.';
      } else {
        errorMessage += err.message;
      }
      
      setError(errorMessage);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Join room with validation
  const joinRoom = async () => {
    if (!roomId.trim()) {
      setError('Please enter a room ID');
      return;
    }
    
    if (!isConnected) {
      setError('Not connected to server');
      return;
    }

    try {
      setIsLoading(true);
      const stream = await getUserMedia();
      if (!stream) return;

      socketRef.current.emit('room:join', { roomId: roomId.trim() });
      setRoomJoined(true);
      setError('');
    } catch (err) {
      setError('Failed to join room');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle incoming call
  const handleIncomingCall = useCallback(async ({ from, offer }) => {
    try {
      console.log('Incoming call from:', from);
      const stream = myStream || await getUserMedia();
      if (!stream) return;

      const pc = createPeerConnection();
      if (!pc) return;
      
      peerConnectionRef.current = pc;

      // Add local stream
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current.emit('call:accepted', { to: from, answer });
      setIsInCall(true);
      setRemoteSocketId(from);
    } catch (err) {
      console.error('Error handling incoming call:', err);
      setError('Failed to accept call');
    }
  }, [myStream, createPeerConnection, getUserMedia]);

  // Handle call accepted
  const handleCallAccepted = useCallback(async ({ answer }) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(answer);
      }
    } catch (err) {
      console.error('Error handling call accepted:', err);
      setError('Failed to establish connection');
    }
  }, []);

  // Handle ICE candidate
  const handleIceCandidate = useCallback(async ({ candidate }) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }, []);

  // Make call
  const makeCall = async () => {
    if (!remoteSocketId) {
      setError('No user to call');
      return;
    }

    try {
      setIsLoading(true);
      const stream = myStream || await getUserMedia();
      if (!stream) return;

      const pc = createPeerConnection();
      if (!pc) return;
      
      peerConnectionRef.current = pc;

      // Add local stream
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current.emit('outgoing:call', { to: remoteSocketId, offer });
      setIsInCall(true);
    } catch (err) {
      console.error('Error making call:', err);
      setError('Failed to start call');
    } finally {
      setIsLoading(false);
    }
  };

  // Cleanup call
  const cleanupCall = useCallback(() => {
    setIsInCall(false);
    setRemoteStream(null);
    setConnectionState('new');
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  }, []);

  // End call
  const endCall = () => {
    cleanupResources();
    if (socketRef.current && remoteSocketId) {
      socketRef.current.emit('call:ended', { to: remoteSocketId });
    }
  };

  // Toggle video
  const toggleVideo = () => {
    if (myStream) {
      const videoTrack = myStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
      }
    }
  };

  // Toggle audio
  const toggleAudio = () => {
    if (myStream) {
      const audioTrack = myStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
      }
    }
  };

  // Copy room ID
  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      // You could add a toast notification here
    } catch (err) {
      console.error('Failed to copy room ID:', err);
    }
  };

  // Generate room ID
  const generateRoomId = () => {
    const id = Math.random().toString(36).substring(2, 15) + 
              Math.random().toString(36).substring(2, 5);
    setRoomId(id);
  };

  // Update remote video when stream changes
  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <div className="bg-gray-800 p-4 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Video className="w-8 h-8 text-blue-500" />
            VideoCall App
          </h1>
          <div className="flex items-center gap-4">
            {/* Connection Status */}
            <div className="flex items-center gap-2">
              {isConnected ? (
                <Wifi className="w-4 h-4 text-green-500" />
              ) : (
                <WifiOff className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm">{isConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
            
            {/* Connection State */}
            {isInCall && (
              <div className="text-sm">
                Status: <span className={`font-medium ${
                  connectionState === 'connected' ? 'text-green-400' :
                  connectionState === 'connecting' ? 'text-yellow-400' :
                  connectionState === 'failed' ? 'text-red-400' : 'text-gray-400'
                }`}>
                  {connectionState}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4">
        {/* Error Message */}
        {error && (
          <div className="bg-red-600 text-white p-3 rounded-lg mb-4 flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        )}

        {!isInCall ? (
          /* Room Setup */
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Join or Create a Room</h2>
            <div className="flex flex-col sm:flex-row gap-4 mb-4">
              <input
                type="text"
                placeholder="Enter Room ID"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
                disabled={isLoading}
              />
              <button
                onClick={generateRoomId}
                disabled={isLoading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                Generate ID
              </button>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={joinRoom}
                disabled={!roomId.trim() || !isConnected || isLoading}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <Users className="w-4 h-4" />
                )}
                {isLoading ? 'Joining...' : 'Join Room'}
              </button>
              
              {roomId && (
                <button
                  onClick={copyRoomId}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2"
                >
                  <Copy className="w-4 h-4" />
                  Copy ID
                </button>
              )}
            </div>

            {roomJoined && !remoteSocketId && (
              <div className="mt-4 p-4 bg-blue-900/30 border border-blue-700 rounded-lg">
                <p className="text-blue-400">Waiting for another user to join the room...</p>
                <p className="text-sm text-gray-400 mt-1">Share the room ID: <strong>{roomId}</strong></p>
              </div>
            )}
            
            {remoteSocketId && (
              <div className="mt-4 p-4 bg-green-900/30 border border-green-700 rounded-lg">
                <p className="text-green-400 mb-2">✅ User joined the room!</p>
                <button
                  onClick={makeCall}
                  disabled={isLoading}
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg transition-colors flex items-center gap-2"
                >
                  {isLoading ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  ) : (
                    <Phone className="w-4 h-4" />
                  )}
                  {isLoading ? 'Starting...' : 'Start Call'}
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Video Call Interface */
          <div className="space-y-4">
            {/* Video Container */}
            <div className="relative bg-gray-800 rounded-lg overflow-hidden" style={{ aspectRatio: '16/9' }}>
              {/* Remote Video */}
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              
              {/* Local Video (Picture-in-Picture) */}
              <div className="absolute top-4 right-4 w-48 h-36 bg-gray-700 rounded-lg overflow-hidden border-2 border-gray-600">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {!isVideoEnabled && (
                  <div className="absolute inset-0 bg-gray-800 flex items-center justify-center">
                    <VideoOff className="w-8 h-8 text-gray-400" />
                  </div>
                )}
              </div>

              {/* Connection Status Overlay */}
              {connectionState === 'connecting' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                    <p className="text-white">Connecting...</p>
                  </div>
                </div>
              )}

              {/* No remote stream message */}
              {!remoteStream && connectionState !== 'connecting' && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                  <div className="text-center">
                    <Users className="w-16 h-16 mx-auto mb-4 text-gray-400" />
                    <p className="text-gray-400">Waiting for other user's video...</p>
                  </div>
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="flex justify-center space-x-4">
              <button
                onClick={toggleAudio}
                className={`p-3 rounded-full transition-colors ${
                  isAudioEnabled ? 'bg-gray-600 hover:bg-gray-700' : 'bg-red-600 hover:bg-red-700'
                }`}
                title={isAudioEnabled ? 'Mute' : 'Unmute'}
              >
                {isAudioEnabled ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
              </button>

              <button
                onClick={toggleVideo}
                className={`p-3 rounded-full transition-colors ${
                  isVideoEnabled ? 'bg-gray-600 hover:bg-gray-700' : 'bg-red-600 hover:bg-red-700'
                }`}
                title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
              >
                {isVideoEnabled ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
              </button>

              <button
                onClick={endCall}
                className="p-3 bg-red-600 hover:bg-red-700 rounded-full transition-colors"
                title="End call"
              >
                <PhoneOff className="w-6 h-6" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoCallApp;