(() => {
  'use strict';

  class AudioCall {
    constructor({ socket, iceServers = [], remoteAudio, onState = () => {} }) {
      this.socket = socket;
      this.iceServers = iceServers;
      this.remoteAudio = remoteAudio;
      this.onState = onState;
      this.peer = null;
      this.localStream = null;
      this.callId = null;
      this.bound = false;
      this.muted = false;
      this.pendingIce = [];
    }

    bindSignals() {
      if (this.bound) return;
      this.bound = true;

      this.socket.on('webrtc:offer', async ({ callId, payload }) => {
        if (callId !== this.callId || !payload) return;
        try {
          await this.ensurePeer();
          await this.peer.setRemoteDescription(payload);
          await this.flushPendingIce();
          const answer = await this.peer.createAnswer();
          await this.peer.setLocalDescription(answer);
          this.socket.emit('webrtc:answer', { callId, payload: this.peer.localDescription });
        } catch (error) {
          console.error('Could not answer WebRTC offer:', error);
          this.onState('failed');
        }
      });

      this.socket.on('webrtc:answer', async ({ callId, payload }) => {
        if (callId !== this.callId || !payload) return;
        try {
          await this.ensurePeer();
          await this.peer.setRemoteDescription(payload);
          await this.flushPendingIce();
        } catch (error) { console.error('Could not set WebRTC answer:', error); }
      });

      this.socket.on('webrtc:ice', async ({ callId, payload }) => {
        if (callId !== this.callId || !payload) return;
        try {
          if (!this.peer?.remoteDescription) {
            this.pendingIce.push(payload);
            return;
          }
          await this.peer.addIceCandidate(payload);
        } catch (error) { console.warn('ICE candidate rejected:', error); }
      });
    }

    async flushPendingIce() {
      if (!this.peer?.remoteDescription || !this.pendingIce.length) return;
      const candidates = this.pendingIce.splice(0);
      for (const candidate of candidates) {
        try { await this.peer.addIceCandidate(candidate); }
        catch (error) { console.warn('Queued ICE candidate rejected:', error); }
      }
    }

    async ensureMedia() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser does not support microphone calling. Use a recent Chrome, Edge or Safari browser.');
      }
      if (this.localStream) return this.localStream;
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      return this.localStream;
    }

    async ensurePeer() {
      if (this.peer) return this.peer;
      const stream = await this.ensureMedia();
      this.peer = new RTCPeerConnection({ iceServers: this.iceServers });
      stream.getTracks().forEach((track) => this.peer.addTrack(track, stream));

      this.peer.onicecandidate = ({ candidate }) => {
        if (candidate && this.callId) {
          this.socket.emit('webrtc:ice', { callId: this.callId, payload: candidate });
        }
      };
      this.peer.ontrack = ({ streams }) => {
        if (!this.remoteAudio || !streams[0]) return;
        this.remoteAudio.srcObject = streams[0];
        this.remoteAudio.play().catch(() => {});
      };
      this.peer.onconnectionstatechange = () => this.onState(this.peer.connectionState);
      this.peer.oniceconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(this.peer?.iceConnectionState)) {
          this.onState(this.peer.iceConnectionState);
        }
      };
      return this.peer;
    }

    async start(callId, initiator) {
      this.stopPeerOnly();
      this.pendingIce = [];
      this.callId = callId;
      this.bindSignals();
      await this.ensurePeer();
      if (initiator) {
        const offer = await this.peer.createOffer({ offerToReceiveAudio: true });
        await this.peer.setLocalDescription(offer);
        this.socket.emit('webrtc:offer', { callId, payload: this.peer.localDescription });
      }
    }

    toggleMute() {
      const track = this.localStream?.getAudioTracks()[0];
      if (!track) return false;
      track.enabled = !track.enabled;
      this.muted = !track.enabled;
      return this.muted;
    }

    stopPeerOnly() {
      if (this.peer) {
        this.peer.ontrack = null;
        this.peer.onicecandidate = null;
        this.peer.close();
      }
      this.peer = null;
      if (this.remoteAudio) this.remoteAudio.srcObject = null;
    }

    stop() {
      this.stopPeerOnly();
      this.localStream?.getTracks().forEach((track) => track.stop());
      this.localStream = null;
      this.callId = null;
      this.pendingIce = [];
      this.muted = false;
    }
  }

  window.AudioCall = AudioCall;
})();
