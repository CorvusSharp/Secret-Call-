package com.example.androidcall

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.example.androidcall.databinding.ActivityMainBinding
import org.webrtc.IceCandidate

class MainActivity : AppCompatActivity(), SignalingClient.Listener {
    private lateinit var binding: ActivityMainBinding
    private var signaling: SignalingClient? = null
    private var rtc: WebRtcClient? = null
    private var joined = false

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) startJoin() else binding.statusView.text = "Microphone denied"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.joinLeaveButton.setOnClickListener {
            if (!joined) checkPermsAndJoin() else leave()
        }
    }

    private fun checkPermsAndJoin() {
        when {
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> startJoin()
            else -> requestPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startJoin() {
        val name = binding.nameInput.text.toString().trim()
        val token = binding.tokenInput.text.toString().trim()
        if (name.isEmpty() || token.isEmpty()) {
            binding.statusView.text = "Name and token required"
            return
        }
        val server = "http://10.0.2.2:8790" // emulator -> host
        signaling = SignalingClient(server, token, this)
        rtc = WebRtcClient(this, signaling!!)
        rtc?.startLocalAudio()
        signaling?.connect()
        signaling?.sendName(name)
        binding.statusView.text = "Joining..."
        joined = true
        binding.joinLeaveButton.setText(R.string.leave)
    }

    private fun leave() {
        joined = false
        signaling?.close(); signaling = null
        rtc?.close(); rtc = null
        binding.joinLeaveButton.setText(R.string.join)
        binding.statusView.text = "Left"
    }

    // SignalingClient.Listener
    override fun onHello(id: String, roster: List<String>) {
        rtc?.setSelfId(id)
        binding.statusView.text = "Connected"
        roster.forEach { if (it != id) rtc?.maybeCall(it) }
    }

    override fun onPeerJoined(id: String) {
        rtc?.maybeCall(id)
    }

    override fun onPeerLeft(id: String) {
        rtc?.removePeer(id)
    }

    override fun onOffer(from: String, sdp: String) {
        rtc?.onOffer(from, sdp)
    }

    override fun onAnswer(from: String, sdp: String) {
        rtc?.onAnswer(from, sdp)
    }

    override fun onIceCandidate(from: String, candidate: IceCandidate?) {
        rtc?.onIceCandidate(from, candidate)
    }
}
