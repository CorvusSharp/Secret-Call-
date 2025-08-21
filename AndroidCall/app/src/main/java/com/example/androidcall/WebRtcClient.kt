package com.example.androidcall

import android.content.Context
import org.webrtc.*

class WebRtcClient(
    private val context: Context,
    private val signaling: SignalingClient
) {
    private val factory: PeerConnectionFactory
    private var localStream: MediaStream? = null
    private val pcs = mutableMapOf<String, PeerConnection>()
    private var myId: String? = null

    init {
        val options = PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions()
        PeerConnectionFactory.initialize(options)
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
    }

    fun setSelfId(id: String) { myId = id }

    fun startLocalAudio() {
        val audioSource = factory.createAudioSource(MediaConstraints())
        val audioTrack = factory.createAudioTrack("mic", audioSource)
        localStream = factory.createLocalMediaStream("stream").apply {
            addTrack(audioTrack)
        }
    }

    fun maybeCall(remoteId: String) {
        val self = myId ?: return
        if (self >= remoteId) return
        val pc = pcs[remoteId] ?: createPeer(remoteId)
        pc.createOffer(object: SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(SdpObserverAdapter(), desc)
                signaling.sendOffer(remoteId, desc.description)
            }
        }, MediaConstraints())
    }

    private fun createPeer(remoteId: String): PeerConnection {
        val config = PeerConnection.RTCConfiguration(emptyList())
        val pc = factory.createPeerConnection(config, object: PeerConnectionObserverAdapter() {
            override fun onIceCandidate(candidate: IceCandidate) {
                signaling.sendIce(remoteId, candidate)
            }

            override fun onAddStream(stream: MediaStream) {
                // TODO: attach stream to audio output
            }
        }) ?: throw IllegalStateException("pc null")
        localStream?.let { pc.addStream(it) }
        pcs[remoteId] = pc
        return pc
    }

    fun onOffer(from: String, sdp: String) {
        val pc = pcs[from] ?: createPeer(from)
        pc.setRemoteDescription(SdpObserverAdapter(), SessionDescription(SessionDescription.Type.OFFER, sdp))
        pc.createAnswer(object: SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(SdpObserverAdapter(), desc)
                signaling.sendAnswer(from, desc.description)
            }
        }, MediaConstraints())
    }

    fun onAnswer(from: String, sdp: String) {
        pcs[from]?.setRemoteDescription(SdpObserverAdapter(), SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    fun onIceCandidate(from: String, candidate: IceCandidate?) {
        if (candidate != null) pcs[from]?.addIceCandidate(candidate)
    }

    fun removePeer(id: String) {
        pcs.remove(id)?.dispose()
    }

    fun close() {
        pcs.values.forEach { it.dispose() }
        pcs.clear()
        localStream?.let {
            it.audioTracks.forEach { t -> t.dispose() }
            it.dispose()
        }
        factory.dispose()
    }
}

open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(p0: String?) {}
    override fun onSetFailure(p0: String?) {}
}

open class PeerConnectionObserverAdapter : PeerConnection.Observer {
    override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
    override fun onIceConnectionReceivingChange(p0: Boolean) {}
    override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
    override fun onIceCandidate(p0: IceCandidate) {}
    override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
    override fun onAddStream(p0: MediaStream) {}
    override fun onRemoveStream(p0: MediaStream) {}
    override fun onDataChannel(p0: DataChannel?) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
}
