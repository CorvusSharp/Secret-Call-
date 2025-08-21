package com.example.androidcall

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import org.webrtc.IceCandidate

class SignalingClient(
    private val baseUrl: String,
    private val token: String,
    private val listener: Listener
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(10, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null

    fun connect() {
        val scheme = if (baseUrl.startsWith("https")) "wss" else "ws"
        val url = baseUrl.replaceFirst(Regex("^https?"), scheme) + "/ws?t=" + token
        val req = Request.Builder()
            .url(url)
            .addHeader("Sec-WebSocket-Protocol", "token.$token")
            .build()
        ws = client.newWebSocket(req, socketListener)
    }

    fun sendName(name: String) {
        val obj = JSONObject()
        obj.put("type", "name")
        obj.put("name", name)
        ws?.send(obj.toString())
    }

    fun sendOffer(to: String, sdp: String) {
        val obj = JSONObject()
        obj.put("type", "offer")
        obj.put("to", to)
        obj.put("sdp", sdp)
        obj.put("sdpType", "offer")
        ws?.send(obj.toString())
    }

    fun sendAnswer(to: String, sdp: String) {
        val obj = JSONObject()
        obj.put("type", "answer")
        obj.put("to", to)
        obj.put("sdp", sdp)
        obj.put("sdpType", "answer")
        ws?.send(obj.toString())
    }

    fun sendIce(to: String, candidate: IceCandidate?) {
        val obj = JSONObject()
        obj.put("type", "ice")
        obj.put("to", to)
        if (candidate != null) {
            val c = JSONObject()
            c.put("candidate", candidate.sdp)
            c.put("sdpMid", candidate.sdpMid)
            c.put("sdpMLineIndex", candidate.sdpMLineIndex)
            obj.put("candidate", c)
        } else {
            obj.put("candidate", JSONObject.NULL)
        }
        ws?.send(obj.toString())
    }

    fun close() {
        ws?.close(4005, "user left")
        ws = null
    }

    private val socketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
            Log.d("Signaling", "WebSocket open")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val m = JSONObject(text)
                when (m.getString("type")) {
                    "hello" -> {
                        val id = m.getString("id")
                        val rosterArr = m.optJSONArray("roster")
                        val roster = mutableListOf<String>()
                        if (rosterArr != null) {
                            for (i in 0 until rosterArr.length()) {
                                roster.add(rosterArr.getString(i))
                            }
                        }
                        listener.onHello(id, roster)
                    }
                    "peer-joined" -> listener.onPeerJoined(m.getString("id"))
                    "peer-left" -> listener.onPeerLeft(m.getString("id"))
                    "offer" -> listener.onOffer(m.getString("from"), m.getString("sdp"))
                    "answer" -> listener.onAnswer(m.getString("from"), m.getString("sdp"))
                    "ice" -> {
                        val c = m.optJSONObject("candidate")
                        val cand = if (c != null) {
                            IceCandidate(
                                c.optString("sdpMid"),
                                c.optInt("sdpMLineIndex"),
                                c.optString("candidate")
                            )
                        } else null
                        listener.onIceCandidate(m.getString("from"), cand)
                    }
                    "full" -> listener.onFull()
                    "browser-only" -> listener.onBrowserOnly()
                    "chat" -> listener.onChat(m)
                }
            } catch (e: Exception) {
                Log.e("Signaling", "parse", e)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
            Log.e("Signaling", "failure", t)
        }
    }

    interface Listener {
        fun onHello(id: String, roster: List<String>)
        fun onPeerJoined(id: String)
        fun onPeerLeft(id: String)
        fun onOffer(from: String, sdp: String)
        fun onAnswer(from: String, sdp: String)
        fun onIceCandidate(from: String, candidate: IceCandidate?)
        fun onFull() {}
        fun onBrowserOnly() {}
        fun onChat(obj: JSONObject) {}
    }
}
