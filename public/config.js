// Deluxe Meet settings. Leave empty to use PeerJS's free public call server
// (0.peerjs.com) to introduce people; the calls themselves go peer to peer.
//
// To use your own PeerJS server (https://github.com/peers/peerjs-server):
//   window.MEET_CONFIG = { peer: { host: 'peer.example.com', port: 443, path: '/', secure: true } };
// To add your own TURN server for strict networks:
//   window.MEET_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:turn.example.com:3478', username: '…', credential: '…' }] };
window.MEET_CONFIG = window.MEET_CONFIG || {};
